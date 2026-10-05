import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const COMMAND_TO_EVENT = {
  'create-order': 'order-created',
  'add-item': 'item-added',
  'complete-item': 'item-completed',
  'undo-item': 'item-unready',
  'cancel-item': 'item-canceled',
  'remake-item': 'item-remade',
  'confirm-pickup': 'pickup-confirmed'
};

const ITEM_EVENT_TYPES = new Set([
  'item-added',
  'item-completed',
  'item-unready',
  'item-canceled',
  'item-remade'
]);

export class ValidationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    this.details = details;
  }
}

export function businessDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError('INVALID_DATE', '营业日格式无效');
  }
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function stableSignature(command) {
  return JSON.stringify({
    type: command.type,
    orderId: command.orderId,
    date: command.date,
    pickupNo: command.pickupNo,
    itemId: command.itemId,
    expectedVersion: command.expectedVersion,
    item: command.item && {
      id: command.item.id,
      name: command.item.name,
      qty: command.item.qty,
      window: command.item.window,
      notes: command.item.notes
    },
    items: command.items?.map((item) => ({
      id: item.id,
      name: item.name,
      qty: item.qty,
      window: item.window,
      notes: item.notes
    }))
  });
}

function emptyProjection() {
  return {
    globalVersion: 0,
    orders: new Map(),
    ordersByDate: new Map(),
    dailyCounters: new Map(),
    transitions: [],
    lastEventAt: null
  };
}

function orderStatus(order) {
  if (order.pickedAt) return 'picked';
  const active = order.items.filter((item) => !item.canceled);
  if (active.length === 0) return 'empty';
  return active.every((item) => item.ready) ? 'ready' : 'preparing';
}

function publicOrder(order) {
  const { events, ...safe } = order;
  return clone({ ...safe, status: orderStatus(order) });
}

export class EventStore {
  constructor(file = path.resolve('data', 'events.jsonl')) {
    this.file = file;
    this.state = emptyProjection();
    this.events = [];
    this.idempotency = new Map();
    this.tail = Promise.resolve();
    this._loaded = false;
  }

  async load() {
    if (this._loaded) return;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    let text = '';
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    text.split('\n').filter(Boolean).forEach((line, index) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        throw new Error(`事件日志第 ${index + 1} 行不是合法 JSON，已停止加载以避免投影分歧: ${error.message}`);
      }
      this._applyEvent(event);
    });
    this._loaded = true;
  }

  // 所有写命令进入同一临界区；单进程内读取的是一致投影。
  async command(rawCommand) {
    await this.load();
    return this._serialize(() => this._commandLocked(rawCommand));
  }

  _serialize(job) {
    const result = this.tail.then(job, job);
    // 防止前一个失败中断后续链式任务。
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async _commandLocked(input) {
    const command = { ...input };
    command.date = command.date ? businessDate(command.date) : businessDate();
    command.at = command.at || nowIso();
    command.by = String(command.by || '匿名员工').slice(0, 80);
    command.reason = command.reason === undefined ? '' : String(command.reason).slice(0, 240);
    command.idempotencyKey = command.idempotencyKey ? String(command.idempotencyKey) : crypto.randomUUID();

    const previous = this.idempotency.get(command.idempotencyKey);
    if (previous) {
      if (previous.signature && previous.signature !== stableSignature(command)) {
        throw new ValidationError('IDEMPOTENCY_KEY_REUSED', '相同幂等键对应了不同命令，拒绝执行');
      }
      return { duplicate: true, event: clone(previous.event), order: this.getOrder(previous.event.payload.orderId), transition: previous.transition ? clone(previous.transition) : null };
    }

    const type = COMMAND_TO_EVENT[command.type];
    if (!type) throw new ValidationError('UNKNOWN_COMMAND', `未知命令: ${command.type}`);
    const payload = this._buildPayload(type, command);
    const event = {
      eventId: crypto.randomUUID(),
      globalVersion: this.state.globalVersion + 1,
      eventType: type,
      at: command.at,
      by: command.by,
      reason: command.reason,
      idempotencyKey: command.idempotencyKey,
      payload
    };

    await this._append(event);
    await this._applyEvent(event);
    const transition = [...this.state.transitions].reverse().find((row) => row.eventId === event.eventId) || null;

    const stored = { event: clone(event), signature: stableSignature(command), transition: transition ? clone(transition) : null };
    this.idempotency.set(command.idempotencyKey, stored);
    return { duplicate: false, event: clone(event), order: this.getOrder(payload.orderId), transition: transition ? clone(transition) : null };
  }

  _buildPayload(eventType, command) {
    if (eventType === 'order-created') return this._buildCreated(command);
    return this._buildItemOrPickup(eventType, command);
  }

  _buildCreated(command) {
    if (!Array.isArray(command.items) || command.items.length === 0) {
      throw new ValidationError('ORDER_ITEMS_REQUIRED', '订单至少包含一个明细');
    }
    const orderId = command.orderId || crypto.randomUUID();
    if (this.state.orders.has(orderId)) {
      throw new ValidationError('ORDER_EXISTS', '稳定订单 ID 已存在', { orderId });
    }
    const items = command.items.map((item, index) => this._normalizeItem(item, `items[${index}]`, 1));
    const windows = [...new Set(items.map((item) => item.window))].sort();
    const pickupNo = command.pickupNo ? this._normalizePickupNo(command.pickupNo) : this._nextPickupNo(command.date);
    this._assertPickupNoAvailable(command.date, pickupNo);
    return {
      orderId,
      date: command.date,
      pickupNo,
      source: String(command.source || 'POS').slice(0, 40),
      note: String(command.note || '').slice(0, 240),
      windows,
      items
    };
  }

  _buildItemOrPickup(eventType, command) {
    const order = this._requireOrder(command.orderId, command.date);
    const base = { orderId: order.id, date: order.date, pickupNo: order.pickupNo };

    if (eventType === 'item-added') {
      if (orderStatus(order) === 'picked') {
        throw new ValidationError('ORDER_LOCKED', '订单已取餐；追加菜请新开订单并保留原单轨迹');
      }
      const item = this._normalizeItem(command.item, 'item', 1);
      if (order.items.some((candidate) => candidate.id === item.id)) {
        throw new ValidationError('ITEM_EXISTS', '明细 ID 在订单中已存在', { itemId: item.id });
      }
      return { ...base, expectedOrderVersion: order.version, item };
    }

    if (eventType === 'pickup-confirmed') {
      const status = orderStatus(order);
      if (status === 'picked') {
        // 正常情况下幂等键会拦住同一次确认；这里保护旧键/直连请求。
        throw new ValidationError('ALREADY_PICKED', '订单已完成取餐，不能重复确认');
      }
      if (status !== 'ready') {
        throw new ValidationError('ORDER_NOT_READY', '仍有未完成或已取消后无可取明细，不能确认取餐');
      }
      return { ...base, expectedOrderVersion: order.version };
    }

    if (!command.itemId) throw new ValidationError('ITEM_ID_REQUIRED', '必须携带具体明细 ID');
    const item = order.items.find((candidate) => candidate.id === command.itemId);
    if (!item) throw new ValidationError('ITEM_NOT_FOUND', '明细不存在', { itemId: command.itemId });
    if (orderStatus(order) === 'picked') {
      throw new ValidationError('ORDER_LOCKED', '订单已取餐，事件只允许追加到更正流水，不得改动原可取状态');
    }

    if (eventType === 'item-added') throw new ValidationError('BAD_PATH', '追加菜应使用订单 ID 创建新明细');
    const expected = Number.isInteger(command.expectedVersion) ? command.expectedVersion : item.version;
    if (item.version !== expected) {
      throw new ValidationError('ITEM_VERSION_CONFLICT', '明细版本已变化，请刷新后基于最新明细重试', {
        itemId: item.id,
        expectedVersion: expected,
        currentVersion: item.version
      });
    }

    if (eventType === 'item-completed') {
      if (item.canceled) throw new ValidationError('ITEM_CANCELED', '已取消明细不能完成');
      if (item.ready) throw new ValidationError('ITEM_ALREADY_READY', '该明细版本已经完成');
      return { ...base, itemId: item.id, expectedVersion: item.version };
    }
    if (eventType === 'item-unready') {
      if (item.canceled) throw new ValidationError('ITEM_CANCELED', '已取消明细不能撤销');
      if (!item.ready) throw new ValidationError('ITEM_NOT_READY', '该明细尚未完成，不能撤销');
      return { ...base, itemId: item.id, expectedVersion: item.version, readyVersion: item.readyVersion };
    }
    if (eventType === 'item-canceled') {
      if (item.canceled) throw new ValidationError('ITEM_ALREADY_CANCELED', '该明细已经取消');
      return { ...base, itemId: item.id, expectedVersion: item.version };
    }
    if (eventType === 'item-remade') {
      if (item.canceled) throw new ValidationError('ITEM_CANCELED', '已取消明细不能重做；如需恢复请追加同义新菜并保留取消轨迹');
      if (!item.ready) throw new ValidationError('ITEM_NOT_READY', '只有已完成明细才能登记重新制作');
      return { ...base, itemId: item.id, expectedVersion: item.version, readyVersion: item.readyVersion };
    }
    throw new ValidationError('UNSUPPORTED_EVENT', '不支持的事件类型');
  }

  _normalizeItem(input, pathLabel, version = 1) {
    if (!input || typeof input !== 'object') throw new ValidationError('INVALID_ITEM', `${pathLabel} 必须是对象`);
    const name = String(input.name || '').trim();
    if (!name) throw new ValidationError('ITEM_NAME_REQUIRED', `${pathLabel}.name 必填`);
    const qty = Number(input.qty ?? 1);
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
      throw new ValidationError('INVALID_QTY', `${pathLabel}.qty 必须是 1-99 的整数`);
    }
    return {
      id: input.id ? String(input.id) : crypto.randomUUID(),
      name: name.slice(0, 80),
      qty,
      window: this._normalizeWindow(input.window || 'A'),
      notes: String(input.notes || '').slice(0, 240),
      version,
      status: 'preparing',
      ready: false,
      canceled: false,
      readyVersion: null,
      remakeCount: 0,
      createdAt: input.createdAt || nowIso(),
      history: []
    };
  }

  _normalizeWindow(value) {
    const window = String(value).trim().toUpperCase();
    if (!/^[\p{L}\p{N}_-]{1,8}$/u.test(window)) {
      throw new ValidationError('INVALID_WINDOW', '出餐窗口编号应为 1-8 位字母、数字或短中文');
    }
    return window;
  }

  _normalizePickupNo(value) {
    const pickupNo = String(value).trim().toUpperCase();
    if (!/^[A-Z0-9-]{2,16}$/.test(pickupNo)) throw new ValidationError('INVALID_PICKUP_NO', '取餐号格式无效');
    return pickupNo;
  }

  _nextPickupNo(date) {
    const used = this.state.ordersByDate.get(date) || new Set();
    let n = 101;
    const base = new Set([...used].map((id) => this.state.orders.get(id)?.pickupNo));
    while (base.has(String(n))) n += 1;
    return String(n);
  }

  _assertPickupNoAvailable(date, pickupNo) {
    const ids = this.state.ordersByDate.get(date);
    if (!ids) return;
    for (const id of ids) {
      if (this.state.orders.get(id)?.pickupNo === pickupNo) {
        throw new ValidationError('PICKUP_NO_DUPLICATE', '同一营业日内取餐号不能重复', { date, pickupNo });
      }
    }
  }

  _requireOrder(orderId, date) {
    if (!orderId) throw new ValidationError('ORDER_ID_REQUIRED', '更新必须携带稳定订单 ID，禁止只凭取餐号改状态');
    const order = this.state.orders.get(orderId);
    if (!order) throw new ValidationError('ORDER_NOT_FOUND', '订单不存在', { orderId });
    if (date && order.date !== date) throw new ValidationError('DATE_MISMATCH', '订单不属于该营业日；取餐号可按日复用', { orderId, requestedDate: date, orderDate: order.date });
    return order;
  }

  async _append(event) {
    const line = `${JSON.stringify(event)}\n`;
    const before = await fs.readFile(this.file, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  if (before.length > 0 && !before.endsWith('\n')) {
    await fs.appendFile(this.file, '\n', 'utf8');
  }
  await fs.appendFile(this.file, line, 'utf8');
  }

  _applyEvent(event) {
    const p = event.payload;
    if (!p || !p.date || !p.orderId) throw new Error(`事件 ${event.eventId} 缺少订单身份或营业日`);
    if (event.globalVersion !== this.state.globalVersion + 1) {
      throw new Error(`事件段不连续：收到 #${event.globalVersion}，期望 #${this.state.globalVersion + 1}`);
    }

    let order = this.state.orders.get(p.orderId);
    const beforeStatus = order ? orderStatus(order) : 'none';
    if (event.eventType === 'order-created') this._applyCreated(event);
    else if (event.eventType === 'pickup-confirmed') this._applyPickup(event);
    else this._applyItemEvent(event);
    order = this.state.orders.get(p.orderId);
    order.version = event.globalVersion;
    order.updatedAt = event.at;
    const afterStatus = orderStatus(order);
    this._recordDerivedTransition(event, order, beforeStatus, afterStatus);

    this.events.push(clone(event));
    this.state.globalVersion = event.globalVersion;
    this.state.lastEventAt = event.at;
    if (event.idempotencyKey && !this.idempotency.has(event.idempotencyKey)) {
      this.idempotency.set(event.idempotencyKey, { event: clone(event), signature: null, transition: null });
    }
  }

  _applyCreated(event) {
    const p = event.payload;
    if (this.state.orders.has(p.orderId)) throw new Error(`重复订单 ID: ${p.orderId}`);
    this._assertPickupNoAvailable(p.date, p.pickupNo);
    const items = p.items.map((item) => ({
      ...this._normalizeItem(item, item.id, item.version || 1),
      history: []
    }));
    const itemIds = new Set();
    for (const item of items) {
      if (itemIds.has(item.id)) throw new Error(`订单内重复明细 ID: ${item.id}`);
      itemIds.add(item.id);
    }
    const order = {
      id: p.orderId,
      date: p.date,
      pickupNo: p.pickupNo,
      source: p.source || 'POS',
      note: p.note || '',
      windows: p.windows || [...new Set(items.map((item) => item.window))].sort(),
      items,
      version: event.globalVersion,
      createdAt: event.at,
      updatedAt: event.at,
      pickedAt: null,
      readyAt: null,
      readySequence: null
    };
    this.state.orders.set(order.id, order);
    if (!this.state.ordersByDate.has(order.date)) this.state.ordersByDate.set(order.date, new Set());
    this.state.ordersByDate.get(order.date).add(order.id);
    for (const item of order.items) {
      item.history.push(this._history(event, item.id, 'created', 'none', 'preparing'));
    }
  }

  _applyPickup(event) {
    const p = event.payload;
    const order = this.state.orders.get(p.orderId);
    if (!order) throw new Error(`事件引用了不存在订单: ${p.orderId}`);
    if (order.date !== p.date) throw new Error(`事件营业日与订单不一致: ${p.orderId}`);
    if (orderStatus(order) === 'picked') throw new Error(`订单已经取餐: ${p.orderId}`);
    if (orderStatus(order) !== 'ready') throw new Error(`订单尚未全部可取: ${p.orderId}`);
    order.pickedAt = event.at;
    for (const item of order.items) {
      if (!item.canceled) {
        item.history.push(this._history(event, item.id, 'picked', item.status, 'picked'));
      }
    }
  }

  _applyItemEvent(event) {
    const p = event.payload;
    const order = this.state.orders.get(p.orderId);
    if (!order) throw new Error(`事件引用了不存在订单: ${p.orderId}`);
    if (order.date !== p.date) throw new Error(`事件营业日与订单不一致: ${p.orderId}`);

    if (event.eventType === 'item-added') {
      if (order.items.some((item) => item.id === p.item.id)) throw new Error(`重复明细 ID: ${p.item.id}`);
      const item = this._normalizeItem(p.item, p.item.id, p.item.version || 1);
      item.history.push(this._history(event, item.id, 'created', 'none', 'preparing'));
      order.items.push(item);
      order.windows = [...new Set([...order.windows, item.window])].sort();
      return;
    }

    const item = order.items.find((candidate) => candidate.id === p.itemId);
    if (!item) throw new Error(`事件引用了不存在明细: ${p.itemId}`);
    if (item.version !== p.expectedVersion) {
      throw new Error(`事件版本冲突：明细 ${p.itemId} 期望当前版本 ${p.expectedVersion}，实际 ${item.version}`);
    }

    const from = item.status;
    item.version += 1;
    if (event.eventType === 'item-completed') {
      item.ready = true;
      item.status = 'ready';
      item.readyVersion = item.version;
    } else if (event.eventType === 'item-unready') {
      item.ready = false;
      item.status = 'preparing';
      item.readyVersion = null;
    } else if (event.eventType === 'item-canceled') {
      item.canceled = true;
      item.ready = false;
      item.readyVersion = null;
      item.status = 'canceled';
      item.canceledAt = event.at;
    } else if (event.eventType === 'item-remade') {
      item.remakeCount += 1;
      item.ready = false;
      item.readyVersion = null;
      item.status = 'preparing';
      item.remadeFromVersion = p.readyVersion;
    } else {
      throw new Error(`不支持重放的明细事件: ${event.eventType}`);
    }
    item.history.push(this._history(event, item.id, event.eventType.replace('item-', ''), from, item.status));

    const active = order.items.filter((candidate) => !candidate.canceled);
    if (active.length === 0 || !active.every((candidate) => candidate.ready)) {
      // 撤销、重做或取消会让旧的“整单可取”公告失效；新一次全齐将获得新的顺序号。
      order.readyAt = null;
      order.readySequence = null;
    }
  }

  _history(event, itemId, type, from, to) {
    return {
      eventId: event.eventId,
      globalVersion: event.globalVersion,
      itemId,
      type,
      from,
      to,
      at: event.at,
      by: event.by,
      reason: event.reason
    };
  }

  _recordDerivedTransition(event, order, before, after) {
    if (before === after && event.eventType !== 'pickup-confirmed') return;
    if (event.eventType === 'order-created') {
      this._pushTransition(event, order, 'none', after);
      return;
    }
    if (before !== after) {
      if (after === 'ready' && before !== 'picked') {
        const key = order.date;
        const next = (this.state.dailyCounters.get(key) || 0) + 1;
        this.state.dailyCounters.set(key, next);
        order.readySequence = next;
        order.readyAt = event.at;
      }
      this._pushTransition(event, order, before, after);
    }
  }

  _pushTransition(event, order, from, to) {
    this.state.transitions.push({
      eventId: event.eventId,
      globalVersion: event.globalVersion,
      orderId: order.id,
      date: order.date,
      pickupNo: order.pickupNo,
      from,
      to,
      readySequence: order.readySequence,
      at: event.at,
      by: event.by,
      reason: event.reason,
      eventType: event.eventType
    });
  }

  getOrder(id) {
    const order = this.state.orders.get(id);
    return order ? publicOrder(order) : null;
  }

  getEvents({ date, orderId, after = 0, limit = 500 } = {}) {
    let rows = this.events.filter((event) => event.globalVersion > after);
    if (date) rows = rows.filter((event) => event.payload.date === date);
    if (orderId) rows = rows.filter((event) => event.payload.orderId === orderId);
    rows = rows.slice(0, Math.min(Number(limit) || 500, 2000));
    return clone(rows);
  }

  getTransitions({ date, orderId, limit = 500 } = {}) {
    let rows = [...this.state.transitions];
    if (date) rows = rows.filter((row) => row.date === date);
    if (orderId) rows = rows.filter((row) => row.orderId === orderId);
    rows.sort((a, b) => a.globalVersion - b.globalVersion);
    return clone(rows.slice(-Math.min(Number(limit) || 500, 2000)));
  }

  getSnapshot(date = businessDate()) {
    const normalizedDate = businessDate(date);
    const ids = this.state.ordersByDate.get(normalizedDate) || new Set();
    const orders = [...ids].map((id) => publicOrder(this.state.orders.get(id)));
    orders.sort((a, b) => {
      const aq = a.readySequence ?? Number.POSITIVE_INFINITY;
      const bq = b.readySequence ?? Number.POSITIVE_INFINITY;
      if (aq !== bq) return aq - bq;
      return a.createdAt.localeCompare(b.createdAt);
    });
    const ready = orders.filter((order) => order.status === 'ready');
    return {
      date: normalizedDate,
      globalVersion: this.state.globalVersion,
      lastEventAt: this.state.lastEventAt,
      readySequence: this.state.dailyCounters.get(normalizedDate) || 0,
      ready,
      orders
    };
  }
}
