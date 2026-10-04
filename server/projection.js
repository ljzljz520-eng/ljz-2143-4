// 纯函数式事件投影：从事件日志折叠出当前读模型。
// 关键不变量：
//  - 明细行带 version，任何追加/取消/重做都落具体行版本，不存在"按最后消息整单改状态"
//  - 订单是否可取 = 所有"未取消明细"全部完成（双窗口跨窗口聚合）；部分完成不进可取队列
//  - 已取餐订单是闭环，重做事件不能把它复活（命令层拦截，投影也保持防御）
const ACTIVE = (l) => l && l.status !== 'cancelled';

export function fold(events, state = newState()) {
  for (const e of events) apply(state, e);
  return state;
}

export function newState() {
  return { seq: 0, orders: new Map(), readyQueue: [] };
}

function apply(s, e) {
  s.seq = e.seq;
  switch (e.type) {
    case 'OrderOpened': {
      s.orders.set(e.orderId, {
        id: e.orderId,
        businessDate: e.businessDate,
        pickupNo: e.pickupNo,
        note: e.note || '',
        cancelled: false,
        pickedUp: false,
        pickedUpAt: null,
        pickedUpBy: null,
        createdAt: e.ts,
        lines: new Map(),
        history: [],
        readySince: null,
        readyNonce: 0
      });
      trace(s, e, `开单 取餐号 ${e.pickupNo}`);
      break;
    }
    case 'ItemAdded': {
      const o = must(s, e);
      o.lines.set(e.lineId, {
        id: e.lineId,
        name: e.name,
        qty: e.qty,
        windowId: e.windowId,
        status: 'prepping',
        version: e.version,
        preparedAt: null,
        preparedBy: null
      });
      trace(s, e, `追加明细：${e.qty}× ${e.name}（窗口 ${e.windowId}）v${e.version}`);
      break;
    }
    case 'ItemCancelled': {
      const o = must(s, e);
      const l = o.lines.get(e.lineId);
      if (l) {
        l.status = 'cancelled';
        l.version = e.version;
        trace(s, e, `取消明细：${l.qty}× ${l.name} v${e.version}${e.reason ? '（' + e.reason + '）' : ''}`);
      }
      break;
    }
    case 'ItemPrepared': {
      const o = must(s, e);
      const l = o.lines.get(e.lineId);
      if (l && ACTIVE(l)) {
        l.status = 'done';
        l.version = e.version;
        l.preparedAt = e.ts;
        l.preparedBy = e.by || null;
        trace(s, e, `明细完成：${l.qty}× ${l.name}（窗口 ${l.windowId}）v${e.version}`);
      }
      break;
    }
    case 'ItemPreparationUndone': {
      const o = must(s, e);
      const l = o.lines.get(e.lineId);
      if (l && ACTIVE(l)) {
        l.status = 'prepping';
        l.preparedAt = null;
        l.preparedBy = null;
        trace(s, e, `撤销完成：${l.qty}× ${l.name}（窗口 ${l.windowId}）`);
      }
      break;
    }
    case 'ItemRemade': {
      const o = must(s, e);
      const l = o.lines.get(e.lineId);
      if (l && ACTIVE(l)) {
        l.status = 'prepping';
        l.version = e.version;
        l.preparedAt = null;
        l.preparedBy = null;
        trace(s, e, `重新制作：${l.qty}× ${l.name}（窗口 ${l.windowId}）v${e.version}${e.reason ? '（' + e.reason + '）' : ''}`);
      }
      break;
    }
    case 'OrderPickedUp': {
      const o = must(s, e);
      o.pickedUp = true;
      o.pickedUpAt = e.ts;
      o.pickedUpBy = e.by || null;
      trace(s, e, `确认取餐（操作人：${e.by || '—'}）`);
      break;
    }
    case 'OrderPickupUndone': {
      const o = must(s, e);
      o.pickedUp = false;
      o.pickedUpAt = null;
      o.pickedUpBy = null;
      trace(s, e, `撤销取餐${e.reason ? '（' + e.reason + '）' : ''}`);
      break;
    }
    case 'OrderCancelled': {
      const o = must(s, e);
      o.cancelled = true;
      trace(s, e, `整单取消${e.reason ? '（' + e.reason + '）' : ''}`);
      break;
    }
  }
  recomputeReady(s, e);
}

function must(s, e) {
  const o = s.orders.get(e.orderId);
  if (!o) throw new Error(`event ${e.seq} references unknown order ${e.orderId}`);
  return o;
}

function trace(s, e, label) {
  const o = s.orders.get(e.orderId);
  o.history.push({ seq: e.seq, ts: e.ts, type: e.type, label, by: e.by || null });
}

// 折叠中重算"可取"：进入/离开可取队列由所有明细的聚合状态决定
function recomputeReady(s, e) {
  const o = s.orders.get(e.orderId);
  if (!o) return;
  const active = [...o.lines.values()].filter(ACTIVE);
  const isReady =
    !o.pickedUp && !o.cancelled && active.length > 0 && active.every((l) => l.status === 'done');
  const wasReady = o.readySince != null;
  if (isReady && !wasReady) {
    o.readySince = e.seq;
    o.readyNonce += 1; // 每次重新进入可取都产生新的播报指纹
  } else if (!isReady && wasReady) {
    o.readySince = null;
  }
  s.readyQueue = [...s.orders.values()]
    .filter((x) => x.readySince != null)
    .sort((a, b) => a.readySince - b.readySince)
    .map((x) => x.id);
}

// ---------- 读模型（快照） ----------

export function orderDTO(o) {
  const lines = [...o.lines.values()].map((l) => ({ ...l }));
  return {
    id: o.id,
    businessDate: o.businessDate,
    pickupNo: o.pickupNo,
    note: o.note,
    cancelled: o.cancelled,
    pickedUp: o.pickedUp,
    pickedUpAt: o.pickedUpAt,
    pickedUpBy: o.pickedUpBy,
    createdAt: o.createdAt,
    readySince: o.readySince,
    readyNonce: o.readyNonce,
    windows: [...new Set(lines.filter(ACTIVE).map((l) => l.windowId))].sort(),
    lines
  };
}

// C 屏 / 后厨快照（按营业日过滤）
export function snapshot(s, { businessDate, seq = s.seq } = {}) {
  const today = [...s.orders.values()].filter((o) => o.businessDate === businessDate);
  const active = today.filter((o) => !o.cancelled);
  const windowsOf = (o) =>
    [...new Set([...o.lines.values()].filter(ACTIVE).map((l) => l.windowId))].sort();

  const ready = active
    .filter((o) => o.readySince != null)
    .sort((a, b) => a.readySince - b.readySince)
    .map((o) => ({
      orderId: o.id,
      pickupNo: o.pickupNo,
      windows: windowsOf(o),
      readyNonce: o.readyNonce,
      readySince: o.readySince
    }));

  const making = active
    .filter((o) => !o.pickedUp)
    .map((o) => {
      const lines = [...o.lines.values()].filter(ACTIVE);
      const winMap = new Map();
      for (const l of lines) {
        const w = winMap.get(l.windowId) || { windowId: l.windowId, total: 0, done: 0 };
        w.total += 1;
        if (l.status === 'done') w.done += 1;
        winMap.set(l.windowId, w);
      }
      return {
        orderId: o.id,
        pickupNo: o.pickupNo,
        note: o.note,
        allDone: lines.length > 0 && lines.every((l) => l.status === 'done'),
        windows: [...winMap.values()].sort((a, b) => a.windowId.localeCompare(b.windowId)),
        lines: lines.map((l) => ({
          lineId: l.id,
          name: l.name,
          qty: l.qty,
          windowId: l.windowId,
          status: l.status,
          version: l.version
        }))
      };
    });

  return {
    seq,
    businessDate,
    serverTime: Date.now(),
    ready,
    making,
    windows: [...new Set(active.flatMap((o) => windowsOf(o)))].sort()
  };
}

// 管理页快照：全部营业日 + 完整明细 + 每次状态转换轨迹
export function adminSnapshot(s, { seq = s.seq } = {}) {
  return {
    seq,
    serverTime: Date.now(),
    orders: [...s.orders.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((o) => ({ ...orderDTO(o), history: o.history }))
  };
}

export function currentStatus(o) {
  if (o.pickedUp) return '已取餐';
  if (o.cancelled) return '已取消';
  const active = [...o.lines.values()].filter(ACTIVE);
  if (active.length === 0) return '无有效明细';
  if (active.every((l) => l.status === 'done')) return '待取餐';
  if (active.some((l) => l.status === 'done')) return '部分完成（制作中）';
  return '制作中';
}
