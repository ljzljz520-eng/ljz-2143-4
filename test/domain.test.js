import test from 'node:test';
import assert from 'node:assert/strict';
import { fold, newState, snapshot, adminSnapshot } from '../server/projection.js';
import { makeBus, openTwoWindowOrder, expectCode } from './helpers.js';

test('双窗口：只完成一个窗口不能取餐，两窗口齐了才进可取队列', async () => {
  const { bus, state } = makeBus();
  const { orderId, lineA, lineB } = await openTwoWindowOrder(bus);

  await bus.exec({ type: 'PrepareItem', orderId, lineId: lineA, expectedVersion: 1 });
  assert.deepEqual(snapshot(state, { businessDate: '2026-10-04' }).ready, [], '单窗口完成不算可取');
  await expectCode(bus.exec({ type: 'ConfirmPickup', orderId }), 'NOT_FULLY_PREPARED');

  await bus.exec({ type: 'PrepareItem', orderId, lineId: lineB, expectedVersion: 1 });
  assert.deepEqual(snapshot(state, { businessDate: '2026-10-04' }).ready.map((r) => r.orderId), [orderId]);
  assert.equal((await bus.exec({ type: 'ConfirmPickup', orderId })).ok, true);
});

test('并发完成与撤销：串行化+乐观版本，后到的过期版本被 409 拒绝，服务端状态为准', async () => {
  const { bus } = makeBus();
  const { orderId, lineA } = await openTwoWindowOrder(bus);

  await bus.exec({ type: 'PrepareItem', orderId, lineId: lineA, expectedVersion: 1 });
  // 撤销后明细回到 v2 prepping；拿着旧 v1 去"重做/取消"必须冲突
  await bus.exec({ type: 'UndoPrepareItem', orderId, lineId: lineA });
  await expectCode(bus.exec({ type: 'RemakeItem', orderId, lineId: lineA, expectedVersion: 1 }), 'VERSION_CONFLICT');
  await expectCode(bus.exec({ type: 'CancelItem', orderId, lineId: lineA, expectedVersion: 1 }), 'VERSION_CONFLICT');

  // 并发：两个完成请求同时到（都带 v2）。第一个成功并把版本推进到 v3 done，
  // 第二个完成命令因"已 done"幂等 no-op（不重复出事件、不报错）；撤销完成与重做仍按版本防护
  const [r1, r2] = await Promise.all([
    bus.exec({ type: 'PrepareItem', orderId, lineId: lineA, expectedVersion: 2 }),
    bus.exec({ type: 'PrepareItem', orderId, lineId: lineA, expectedVersion: 2 })
  ]);
  assert.equal(r1.appended.length, 1);
  assert.equal(r2.appended.length, 0, '重复完成幂等');
  const staleDone = await bus.exec({ type: 'PrepareItem', orderId, lineId: lineA, expectedVersion: 2 });
  assert.equal(staleDone.appended.length, 0, '已 done 的迟到完成始终幂等，不因旧版本报错');

  // 完成后撤销完成（保持 v3、回到 prepping），再用当前 v3 重做推进到 v4，旧 v3 重做随后冲突
  await bus.exec({ type: 'UndoPrepareItem', orderId, lineId: lineA });
  await bus.exec({ type: 'RemakeItem', orderId, lineId: lineA, expectedVersion: 3 });
  await expectCode(bus.exec({ type: 'RemakeItem', orderId, lineId: lineA, expectedVersion: 3 }), 'VERSION_CONFLICT');
});

test('重做通知晚于已取餐：闭环拦截，订单不复活，产生拒绝留痕', async () => {
  const { bus, state } = makeBus();
  const { orderId, lineA, lineB } = await openTwoWindowOrder(bus);
  await bus.exec({ type: 'PrepareItem', orderId, lineId: lineA, expectedVersion: 1 });
  await bus.exec({ type: 'PrepareItem', orderId, lineId: lineB, expectedVersion: 1 });
  await bus.exec({ type: 'ConfirmPickup', orderId });
  assert.equal(state.orders.get(orderId).pickedUp, true);

  await expectCode(bus.exec({ type: 'RemakeItem', orderId, lineId: lineA, expectedVersion: 1 }), 'ORDER_CLOSED');
  await expectCode(bus.exec({ type: 'PrepareItem', orderId, lineId: lineA, expectedVersion: 1 }), 'ORDER_CLOSED');
  assert.equal(state.orders.get(orderId).pickedUp, true, '迟到重做不改变任何状态');

  // 先撤销取餐（误确认纠正），再重做才被允许；撤销取餐使订单重新进入可取（指纹换新）
  await bus.exec({ type: 'UndoPickup', orderId, reason: '误触' });
  assert.ok(state.orders.get(orderId).readySince != null, '撤销取餐后重新待取');
  // 重做针对当前明细版本 v2（完成时已是 v2）
  await bus.exec({ type: 'RemakeItem', orderId, lineId: lineA, expectedVersion: 2, reason: '洒了' });
  const o = state.orders.get(orderId);
  assert.equal(o.lines.get(lineA).status, 'prepping');
  assert.equal(o.lines.get(lineA).version, 3, '重做把明细推进到 v3');
  assert.equal(o.readySince, null, '重做后不再可取，需重新完成该明细');
  assert.ok(bus.rejections.some((r) => r.code === 'ORDER_CLOSED'), '拒绝有审计留痕');
});

test('追加菜/取消项/重做都只改具体明细版本，可取状态按所有明细重新聚合', async () => {
  const { bus, state } = makeBus();
  const { orderId, lineA, lineB } = await openTwoWindowOrder(bus);
  await bus.exec({ type: 'PrepareItem', orderId, lineId: lineA, expectedVersion: 1 });
  await bus.exec({ type: 'PrepareItem', orderId, lineId: lineB, expectedVersion: 1 });
  assert.ok(state.orders.get(orderId).readySince != null);

  // 追加菜：新明细独立 v1，订单立即失去可取资格（新菜未做），不动老明细版本
  const add = await bus.exec({ type: 'AddItem', orderId, name: '追加甜品', qty: 1, windowId: 'A' });
  const lineC = add.appended[0].lineId;
  assert.equal(state.orders.get(orderId).readySince, null);
  assert.equal(state.orders.get(orderId).lines.get(lineA).version, 2, '老明细完成后 v2 不受追加影响');
  assert.equal(state.orders.get(orderId).lines.get(lineC).version, 1);

  // 取消新菜 v1 -> v2，订单恢复可取，其余明细版本不变
  await bus.exec({ type: 'CancelItem', orderId, lineId: lineC, expectedVersion: 1 });
  assert.ok(state.orders.get(orderId).readySince != null);
  assert.equal(state.orders.get(orderId).lines.get(lineB).version, 2);
});

test('取餐号跨营业日可复用；同营业日重复占用被拒绝；命令必须携带 orderId', async () => {
  const { bus } = makeBus();
  const d1 = await bus.exec({ type: 'OpenOrder', businessDate: '2026-10-03', pickupNo: '100' });
  await bus.exec({ type: 'ConfirmPickup', orderId: d1.appended[0].orderId }).catch(() => {});
  // 次日同号可以
  const d2 = await bus.exec({ type: 'OpenOrder', businessDate: '2026-10-04', pickupNo: '100' });
  assert.notEqual(d1.appended[0].orderId, d2.appended[0].orderId);
  // 同日同号冲突
  await expectCode(bus.exec({ type: 'OpenOrder', businessDate: '2026-10-04', pickupNo: '100' }), 'PICKUP_NO_TAKEN');
  // 不存在的稳定身份
  await expectCode(bus.exec({ type: 'PrepareItem', orderId: 'ord_nope', lineId: 'x' }), 'ORDER_NOT_FOUND');
});

test('重启重放：顺序由 seq 恢复，readyNonce 递增用于只播报新可取', async () => {
  const { EventStore } = await import('../server/store.js');
  // 空日志也能投影
  assert.equal(fold([], newState()).seq, 0);

  const { bus, state, store } = makeBus();
  const { orderId, lineA, lineB } = await openTwoWindowOrder(bus);
  await bus.exec({ type: 'PrepareItem', orderId, lineId: lineA, expectedVersion: 1 });
  await bus.exec({ type: 'PrepareItem', orderId, lineId: lineB, expectedVersion: 1 });
  const nonce1 = state.orders.get(orderId).readyNonce;
  await bus.exec({ type: 'ConfirmPickup', orderId });
  await bus.exec({ type: 'UndoPickup', orderId });
  assert.equal(state.orders.get(orderId).readyNonce, nonce1 + 1, '撤销取餐重新待取 -> 新指纹，屏幕会再播一次');
  await bus.exec({ type: 'UndoPrepareItem', orderId, lineId: lineA });
  await bus.exec({ type: 'PrepareItem', orderId, lineId: lineA });
  assert.equal(state.orders.get(orderId).readyNonce, nonce1 + 2, '离开再回到可取 -> 再增 nonce');

  // 真正重启：新投影从同一日志重建，顺序与版本一致
  const rebuilt = fold(new EventStore(store.file).readAll(), newState());
  const o2 = rebuilt.orders.get(orderId);
  assert.deepEqual(rebuilt.readyQueue, [orderId]);
  assert.equal(o2.readyNonce, nonce1 + 2);
  assert.equal(o2.lines.get(lineA).version, 3, '完成 v2 -> 撤销完成不升版 -> 再完成 v3');
});

test('管理轨迹：每次转换都可在 history 追到，含明细版本', () => {
  return (async () => {
    const { bus, state } = makeBus();
    const { orderId, lineA } = await openTwoWindowOrder(bus);
    await bus.exec({ type: 'PrepareItem', orderId, lineId: lineA, expectedVersion: 1 });
    await bus.exec({ type: 'RemakeItem', orderId, lineId: lineA, expectedVersion: 2, reason: '错单' });
    const snap = adminSnapshot(state);
    const o = snap.orders.find((x) => x.id === orderId);
    const types = o.history.map((h) => h.type);
    assert.ok(types.includes('OrderOpened'));
    assert.ok(types.includes('ItemAdded'));
    assert.ok(types.includes('ItemPrepared'));
    assert.ok(types.includes('ItemRemade'));
    assert.deepEqual(o.history.map((h) => h.seq).sort((a, b) => a - b), o.history.map((h) => h.seq));
  })();
});
