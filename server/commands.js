// 命令层：所有写操作的唯一入口。
// 规则：
//  1) 在 store 锁内执行：读取聚合 -> 校验不变量 -> 追加事件 -> 更新内存投影
//  2) 明细命令携带 expectedVersion 做乐观并发控制；版本不符返回 409，以服务端为准
//  3) 完成类命令天然幂等（重复完成/重复取消返回 200 no-op）
//  4) 已取餐是闭环：任何修改必须先撤销取餐；"重做晚于已取餐"不会复活订单
//  5) 拒绝同样留痕（rejections 环形日志），管理页可审计"为什么没动"
export class DomainError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.status = 409;
    this.extra = extra;
  }
}

const REJECTION_RING = 300;

export class CommandBus {
  constructor(store, state, businessDateFor) {
    this.store = store;
    this.state = state;
    this.businessDateFor = businessDateFor;
    this.rejections = [];
    this.idem = new Map(); // idempotencyKey -> 上次响应（命令成功）
  }

  reject(code, message, extra) {
    const rec = { ts: Date.now(), code, message, ...extra };
    this.rejections.unshift(rec);
    if (this.rejections.length > REJECTION_RING) this.rejections.pop();
    return new DomainError(code, message, extra);
  }

  async exec(body, idemKey) {
    return this.store.withLock(() => {
      if (idemKey) {
        const cached = this.idem.get(idemKey);
        if (cached) return { ...cached, idempotent: true };
      }
      const events = this.route(body);
      let appended = [];
      for (const ev of events) appended.push(this.store.append(ev));
      for (const ev of appended) foldOne(this.state, ev);
      const out = { ok: true, seq: this.state.seq, events: appended.map((e) => e.seq), appended };
      if (idemKey) {
        this.idem.set(idemKey, out);
        if (this.idem.size > 5000) this.idem.delete(this.idem.keys().next().value);
      }
      return out;
    });
  }

  route(b) {
    if (!b || typeof b !== 'object' || !b.type)
      throw this.reject('BAD_COMMAND', '缺少命令类型');
    const handler = this[b.type];
    if (!handler) throw this.reject('UNKNOWN_COMMAND', `未知命令：${b.type}`);
    return handler.call(this, b);
  }

  _order(id, { requireOpen = true } = {}) {
    const o = this.state.orders.get(id);
    if (!o) throw this.reject('ORDER_NOT_FOUND', '订单不存在', { orderId: id });
    if (requireOpen && o.pickedUp)
      throw this.reject(
        'ORDER_CLOSED',
        '订单已取餐（闭环），需先撤销取餐才能修改；迟到的重做通知被忽略',
        { orderId: id }
      );
    if (requireOpen && o.cancelled)
      throw this.reject('ORDER_CANCELLED', '订单已取消', { orderId: id });
    return o;
  }

  _line(o, lineId) {
    const l = o.lines.get(lineId);
    if (!l)
      throw this.reject('LINE_NOT_FOUND', '明细不存在', { orderId: o.id, lineId });
    if (l.status === 'cancelled')
      throw this.reject('LINE_CANCELLED', '明细已取消', { orderId: o.id, lineId });
    return l;
  }

  _checkVersion(o, l, expected) {
    if (expected != null && Number(expected) !== l.version)
      throw this.reject(
        'VERSION_CONFLICT',
        `明细版本冲突：期望 v${expected}，当前 v${l.version}`,
        { orderId: o.id, lineId: l.id, expected: Number(expected), current: l.version }
      );
  }

  _pickupUnique(date, no, exceptId) {
    for (const o of this.state.orders.values())
      if (o.businessDate === date && o.pickupNo === no && o.id !== exceptId)
        throw this.reject('PICKUP_NO_TAKEN', `营业日 ${date} 取餐号 ${no} 已被占用`, {
          businessDate: date,
          pickupNo: no,
          conflictOrderId: o.id
        });
  }

  // ---------- 命令 ----------

  OpenOrder({ businessDate, pickupNo, note }) {
    const date = businessDate || this.businessDateFor(new Date());
    const no = String(pickupNo ?? '').trim();
    if (!/^[A-Za-z0-9-]{1,12}$/.test(no))
      throw this.reject('BAD_PICKUP_NO', '取餐号须为 1-12 位字母数字');
    this._pickupUnique(date, no, null);
    const orderId = `ord_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    return [{ type: 'OrderOpened', orderId, businessDate: date, pickupNo: no, note: note || '' }];
  }

  AddItem({ orderId, lineId, name, qty, windowId, expectedVersion }) {
    const o = this._order(orderId);
    if (!name || !String(name).trim()) throw this.reject('BAD_ITEM', '明细名称为空');
    const q = Math.trunc(Number(qty));
    if (!q || q <= 0) throw this.reject('BAD_ITEM', '数量必须为正整数');
    const win = String(windowId || 'A').trim();
    const lid = lineId || `li_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    if (o.lines.has(lid)) throw this.reject('LINE_EXISTS', '明细 ID 已存在', { lineId: lid });
    // 追加菜：作为该明细的初始版本 v1
    const version = expectedVersion != null ? Number(expectedVersion) : 1;
    if (version !== 1) throw this.reject('VERSION_CONFLICT', '新明细必须从 v1 开始', { current: 1 });
    return [{ type: 'ItemAdded', orderId, lineId: lid, name: String(name).trim(), qty: q, windowId: win, version }];
  }

  CancelItem({ orderId, lineId, expectedVersion, reason, by }) {
    const o = this._order(orderId);
    const l = this._line(o, lineId);
    this._checkVersion(o, l, expectedVersion);
    return [{ type: 'ItemCancelled', orderId, lineId, version: l.version + 1, reason: reason || '', by: by || null }];
  }

  PrepareItem({ orderId, lineId, expectedVersion, by }) {
    const o = this._order(orderId);
    const l = this._line(o, lineId);
    // 并发双报告：两个"完成"同时到达时，后到者看到已是 done -> 幂等 no-op（先于版本判断）
    if (l.status === 'done') return [];
    this._checkVersion(o, l, expectedVersion);
    return [{ type: 'ItemPrepared', orderId, lineId, version: l.version + 1, by: by || null }];
  }

  UndoPrepareItem({ orderId, lineId, by, reason }) {
    const o = this._order(orderId);
    const l = this._line(o, lineId);
    if (l.status !== 'done')
      throw this.reject('LINE_NOT_DONE', '明细尚未完成，无法撤销完成', { orderId, lineId });
    return [{ type: 'ItemPreparationUndone', orderId, lineId, by: by || null, reason: reason || '' }];
  }

  RemakeItem({ orderId, lineId, expectedVersion, by, reason }) {
    const o = this._order(orderId);
    const l = this._line(o, lineId);
    this._checkVersion(o, l, expectedVersion);
    // 重新制作：保留同一明细身份，但版本 +1 回到制作中；
    // 订单闭环时 _order 已拦截 -> "重做通知晚于已取餐"不会改变任何状态
    return [{ type: 'ItemRemade', orderId, lineId, version: l.version + 1, by: by || null, reason: reason || '' }];
  }

  ConfirmPickup({ orderId, by }) {
    const o = this._order(orderId, { requireOpen: false });
    if (o.pickedUp) return []; // 幂等：缓存/双击产生的重复确认不产生重复事件
    if (o.cancelled) throw this.reject('ORDER_CANCELLED', '订单已取消，不能取餐', { orderId });
    const active = [...o.lines.values()].filter((l) => l.status !== 'cancelled');
    if (active.length === 0) throw this.reject('EMPTY_ORDER', '订单没有有效明细', { orderId });
    const pending = active.filter((l) => l.status !== 'done');
    if (pending.length > 0)
      throw this.reject(
        'NOT_FULLY_PREPARED',
        `还有 ${pending.length} 项未完成，部分完成不能取餐（双窗口均须出齐）`,
        { orderId, pendingLineIds: pending.map((l) => l.id) }
      );
    return [{ type: 'OrderPickedUp', orderId, by: by || null }];
  }

  UndoPickup({ orderId, by, reason }) {
    const o = this._order(orderId, { requireOpen: false });
    if (!o.pickedUp)
      throw this.reject('NOT_PICKED_UP', '订单未处于已取餐状态', { orderId });
    if (o.cancelled)
      throw this.reject('ORDER_CANCELLED', '已取消订单不可撤销取餐', { orderId });
    return [{ type: 'OrderPickupUndone', orderId, by: by || null, reason: reason || '' }];
  }

  CancelOrder({ orderId, by, reason }) {
    const o = this._order(orderId);
    if (o.pickedUp) throw this.reject('ORDER_CLOSED', '已取餐订单不能取消', { orderId });
    const evs = [];
    for (const l of o.lines.values())
      if (l.status !== 'cancelled')
        evs.push({ type: 'ItemCancelled', orderId, lineId: l.id, version: l.version + 1, reason: '整单取消联动', by: by || null });
    evs.push({ type: 'OrderCancelled', orderId, by: by || null, reason: reason || '' });
    return evs;
  }
}

import { fold as foldAll, newState } from './projection.js';
function foldOne(state, event) {
  return foldAll([event], state);
}
export { newState };
