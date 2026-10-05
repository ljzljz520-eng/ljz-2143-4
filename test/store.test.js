import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { EventStore, businessDate, ValidationError } from '../src/store.js';

let counter = 0;
async function makeStore() {
  const file = path.join(await fsRealTemp(), `events-${counter++}.jsonl`);
  const store = new EventStore(file);
  await store.load();
  return store;
}

async function fsRealTemp() {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pickup-test-')));
}
import { promises as fs } from 'node:fs';

async function splitOrder(store, date = businessDate()) {
  const result = await store.command({
    type: 'create-order',
    date,
    pickupNo: `T${Math.floor(Math.random() * 100000)}`,
    items: [
      { id: 'a', name: 'A 菜', qty: 1, window: 'A' },
      { id: 'b', name: 'B 菜', qty: 1, window: 'B' }
    ]
  });
  return result.order;
}

test('双窗口只完成一个窗口时整单不可取，全部完成才分配顺序', async () => {
  const store = await makeStore();
  const date = businessDate();
  const order = await splitOrder(store, date);

  const first = await store.command({ type: 'complete-item', orderId: order.id, date, itemId: 'a', expectedVersion: 1 });
  assert.equal(first.order.status, 'preparing');
  assert.equal(store.getSnapshot(date).ready.length, 0);

  const second = await store.command({ type: 'complete-item', orderId: order.id, date, itemId: 'b', expectedVersion: 1 });
  assert.equal(second.order.status, 'ready');
  assert.equal(second.order.readySequence, 1);
  assert.deepEqual(store.getSnapshot(date).ready.map((item) => item.id), [order.id]);
});

test('追加菜、取消、撤销和重做都改变具体明细版本', async () => {
  const store = await makeStore();
  const date = businessDate();
  const order = await splitOrder(store, date);
  let changed = await store.command({ type: 'complete-item', orderId: order.id, date, itemId: 'a', expectedVersion: 1 });
  assert.equal(changed.order.items.find((item) => item.id === 'a').version, 2);

  changed = await store.command({ type: 'undo-item', orderId: order.id, date, itemId: 'a', expectedVersion: 2 });
  assert.equal(changed.order.items.find((item) => item.id === 'a').status, 'preparing');
  assert.equal(changed.order.items.find((item) => item.id === 'a').version, 3);

  changed = await store.command({ type: 'complete-item', orderId: order.id, date, itemId: 'a', expectedVersion: 3 });
  changed = await store.command({ type: 'complete-item', orderId: order.id, date, itemId: 'b', expectedVersion: 1 });
  assert.equal(changed.order.status, 'ready');

  changed = await store.command({ type: 'add-item', orderId: order.id, date, item: { id: 'c', name: 'C 菜', qty: 2, window: 'C' } });
  assert.equal(changed.order.status, 'preparing');
  assert.equal(changed.order.items.find((item) => item.id === 'c').version, 1);

  changed = await store.command({ type: 'cancel-item', orderId: order.id, date, itemId: 'c', expectedVersion: 1 });
  assert.equal(changed.order.status, 'ready');
  assert.equal(changed.order.items.find((item) => item.id === 'c').version, 2);
  assert.equal(changed.order.items.find((item) => item.id === 'c').status, 'canceled');

  changed = await store.command({ type: 'remake-item', orderId: order.id, date, itemId: 'a', expectedVersion: 4, reason: '洒漏' });
  assert.equal(changed.order.status, 'preparing');
  const item = changed.order.items.find((candidate) => candidate.id === 'a');
  assert.equal(item.version, 5);
  assert.equal(item.ready, false);
  assert.equal(item.remakeCount, 1);
});

test('已取餐后的迟到重做不能修改订单；相同确认幂等返回', async () => {
  const store = await makeStore();
  const date = businessDate();
  const order = await splitOrder(store, date);
  await store.command({ type: 'complete-item', orderId: order.id, date, itemId: 'a', expectedVersion: 1 });
  await store.command({ type: 'complete-item', orderId: order.id, date, itemId: 'b', expectedVersion: 1 });
  const key = 'pick-once';
  const picked = await store.command({ type: 'confirm-pickup', orderId: order.id, date, idempotencyKey: key });
  assert.equal(picked.order.status, 'picked');
  const again = await store.command({ type: 'confirm-pickup', orderId: order.id, date, idempotencyKey: key });
  assert.equal(again.duplicate, true);
  assert.equal(again.event.eventType, 'pickup-confirmed');
  await assert.rejects(
    store.command({ type: 'remake-item', orderId: order.id, date, itemId: 'a', expectedVersion: 2 }),
    (error) => error instanceof ValidationError && error.code === 'ORDER_LOCKED'
  );
});

test('并发完成与撤销按中心顺序处理，旧明细版本不会覆盖新版本', async () => {
  const store = await makeStore();
  const date = businessDate();
  const order = await splitOrder(store, date);
  await store.command({ type: 'complete-item', orderId: order.id, date, itemId: 'b', expectedVersion: 1 });

  const complete = store.command({ type: 'complete-item', orderId: order.id, date, itemId: 'a', expectedVersion: 1 });
  const staleUndo = complete.then(() =>
    store.command({ type: 'undo-item', orderId: order.id, date, itemId: 'a', expectedVersion: 1 }).catch((error) => error)
  );
  const [completed, staleResult] = await Promise.all([complete, staleUndo]);
  assert.equal(completed.order.status, 'ready');
  assert.equal(staleResult.code, 'ITEM_VERSION_CONFLICT');
  assert.equal(completed.order.items.find((item) => item.id === 'a').version, 2);

  // 前端拿到冲突后必须读取新版本，再由操作员明确撤销；中心不会让旧按钮静默回滚。
  const undone = await store.command({ type: 'undo-item', orderId: order.id, date, itemId: 'a', expectedVersion: 2 });
  assert.equal(undone.order.status, 'preparing');
  assert.equal(undone.order.items.find((item) => item.id === 'a').version, 3);
});

test('取餐号可跨营业日复用，但更新必须携带稳定 orderId 和匹配日期', async () => {
  const store = await makeStore();
  const today = businessDate();
  const yesterday = businessDate(new Date(Date.now() - 86_400_000));
  const a = await store.command({ type: 'create-order', date: yesterday, pickupNo: '500', items: [{ id: 'x', name: '旧', window: 'A' }] });
  const b = await store.command({ type: 'create-order', date: today, pickupNo: '500', items: [{ id: 'y', name: '新', window: 'A' }] });
  assert.notEqual(a.order.id, b.order.id);
  await assert.rejects(
    store.command({ type: 'complete-item', orderId: b.order.id, date: yesterday, itemId: 'y', expectedVersion: 1 }),
    (error) => error.code === 'DATE_MISMATCH'
  );
  const done = await store.command({ type: 'complete-item', orderId: b.order.id, date: today, itemId: 'y', expectedVersion: 1 });
  assert.equal(done.order.status, 'ready');
});

test('事件日志重新加载后投影、版本历史和状态转换完全恢复', async () => {
  const store = await makeStore();
  const date = businessDate();
  const order = await splitOrder(store, date);
  await store.command({ type: 'complete-item', orderId: order.id, date, itemId: 'a', expectedVersion: 1 });
  await store.command({ type: 'complete-item', orderId: order.id, date, itemId: 'b', expectedVersion: 1 });
  await store.command({ type: 'confirm-pickup', orderId: order.id, date });

  const restored = new EventStore(store.file);
  await restored.load();
  const loaded = restored.getOrder(order.id);
  assert.equal(loaded.status, 'picked');
  assert.equal(loaded.items.find((item) => item.id === 'a').version, 2);
  assert.equal(loaded.items.find((item) => item.id === 'a').history.length, 3);
  const paths = restored.getTransitions({ orderId: order.id }).map((row) => `${row.from}:${row.to}`);
  assert.deepEqual(paths, ['none:preparing', 'preparing:ready', 'ready:picked']);
});
