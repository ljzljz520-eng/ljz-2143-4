import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventStore } from '../server/store.js';
import { fold, newState } from '../server/projection.js';
import { CommandBus } from '../server/commands.js';

export function makeBus() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickup-'));
  const file = path.join(dir, 'events.jsonl');
  const store = new EventStore(file);
  const state = fold(store.readAll(), newState());
  const bus = new CommandBus(store, state, () => '2026-10-04');
  return { bus, store, state, file };
}

// 双窗口一单：取餐号 100，窗口A一道菜，窗口B一道菜
export async function openTwoWindowOrder(bus, pickupNo = '100', date = '2026-10-04') {
  const open = await bus.exec({ type: 'OpenOrder', businessDate: date, pickupNo });
  const orderId = open.appended[0].orderId;
  const a = await bus.exec({ type: 'AddItem', orderId, name: '牛肉面', qty: 1, windowId: 'A' });
  const b = await bus.exec({ type: 'AddItem', orderId, name: '柠檬茶', qty: 2, windowId: 'B' });
  return { orderId, lineA: a.appended[0].lineId, lineB: b.appended[0].lineId };
}

export function expectCode(p, code) {
  return p.then(
    () => { throw new Error('应当被拒绝'); },
    (e) => { if (e.code !== code) throw new Error(`期望 ${code}，实际 ${e.code}: ${e.message}`); }
  );
}

export function readyOrderIds(state) { return state.readyQueue; }
