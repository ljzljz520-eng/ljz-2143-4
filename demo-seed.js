// 生成演示数据：双窗口单、跨日复用取餐号、部分完成、待取、已取、重做各态。
const B = process.env.BASE || 'http://localhost:8080';
const post = (p) =>
  fetch(`${B}/api/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }).then((r) => r.json());

const run = async () => {
  // 昨日同号（已取餐历史），证明跨日复用
  const y = await post({ type: 'OpenOrder', businessDate: '2026-10-03', pickupNo: '100' });
  const yid = y.appended[0].orderId;
  const yl = await post({ type: 'AddItem', orderId: yid, name: '昨日例汤', qty: 1, windowId: 'A' });
  await post({ type: 'PrepareItem', orderId: yid, lineId: yl.appended[0].lineId, expectedVersion: 1 });
  await post({ type: 'ConfirmPickup', orderId: yid });

  // 今日 100：A/B 双窗口，A 已出 B 未出（部分完成不显示可取）
  const t = await post({ type: 'OpenOrder', businessDate: '2026-10-04', pickupNo: '100' });
  const id = t.appended[0].orderId;
  const la = await post({ type: 'AddItem', orderId: id, name: '招牌牛肉面', qty: 1, windowId: 'A' });
  const lb = await post({ type: 'AddItem', orderId: id, name: '手打柠檬茶', qty: 2, windowId: 'B' });
  await post({ type: 'PrepareItem', orderId: id, lineId: la.appended[0].lineId, expectedVersion: 1 });

  // 今日 101：两窗口齐 -> 待取餐
  const t2 = await post({ type: 'OpenOrder', businessDate: '2026-10-04', pickupNo: '101', note: '少辣' });
  const id2 = t2.appended[0].orderId;
  const c1 = await post({ type: 'AddItem', orderId: id2, name: '黄焖鸡饭', qty: 1, windowId: 'A' });
  const c2 = await post({ type: 'AddItem', orderId: id2, name: '紫菜蛋花汤', qty: 1, windowId: 'B' });
  await post({ type: 'PrepareItem', orderId: id2, lineId: c1.appended[0].lineId, expectedVersion: 1 });
  await post({ type: 'PrepareItem', orderId: id2, lineId: c2.appended[0].lineId, expectedVersion: 1 });

  console.log('演示数据已生成：');
  console.log('  100（昨）已取餐；100（今）A 窗口出餐中、B 未齐 -> 不上屏；101 双窗口齐 -> 上屏待取');
};
run().catch((e) => { console.error(e); process.exit(1); });
