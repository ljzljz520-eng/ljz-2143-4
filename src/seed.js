import path from 'node:path';
import { EventStore, businessDate } from './store.js';

const store = new EventStore(process.env.EVENT_FILE || path.resolve('data', 'events.jsonl'));
await store.load();

if (store.state.globalVersion > 0) {
  console.log(`事件库已有 ${store.state.globalVersion} 条事件，种子脚本不覆盖数据。`);
  process.exit(0);
}

const today = businessDate();
const yesterday = businessDate(new Date(Date.now() - 86_400_000));
const calls = [];

// 昨天和今天使用相同取餐号，验证按营业日复用且更新仍靠稳定 orderId。
calls.push({
  type: 'create-order',
  date: yesterday,
  pickupNo: '101',
  items: [{ name: '历史订单示例', qty: 1, window: 'A' }],
  by: 'seed'
});
const split = {
  type: 'create-order',
  date: today,
  pickupNo: '101',
  items: [
    { id: 'seed-burger', name: '招牌牛肉堡', qty: 1, window: 'A', notes: '少酱' },
    { id: 'seed-drink', name: '柠檬茶', qty: 1, window: 'B' }
  ],
  note: '双窗口出餐示例',
  by: 'seed'
};
calls.push(split);
calls.push({
  type: 'create-order',
  date: today,
  pickupNo: '102',
  items: [{ name: '儿童套餐', qty: 1, window: 'A' }],
  by: 'seed'
});

const results = [];
for (const command of calls) results.push(await store.command(command));
const splitOrder = results[1].order;
const burger = splitOrder.items.find((item) => item.name === '招牌牛肉堡');
await store.command({ type: 'complete-item', orderId: splitOrder.id, date: today, itemId: burger.id, expectedVersion: burger.version, by: 'seed' });
// 只完成 A 窗口时，订单仍不应出现在可取列表；启动后可在后厨页完成 B 窗口。

console.log(`已写入 ${store.state.globalVersion} 条事件。今天是 ${today}。`);
console.log('双窗口示例订单 ID:', splitOrder.id);
