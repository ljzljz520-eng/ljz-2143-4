import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickup-srv-'));
process.env.DATA_FILE = path.join(dir, 'events.jsonl');
process.env.PORT = '0';
process.env.BUSINESS_TZ = 'Asia/Shanghai';
const { server, stop } = await import('../server/index.js');
await new Promise((r) => server.once('listening', r));
const base = `http://localhost:${server.address().port}`;

const cmd = (payload, idem) =>
  fetch(`${base}/api/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(idem ? { 'Idempotency-Key': idem } : {}) },
    body: JSON.stringify(payload)
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

test('HTTP 端到端：双窗口出餐，部分完成不可取，取齐才可确认', async () => {
  const date = '2026-10-04';
  const open = await cmd({ type: 'OpenOrder', businessDate: date, pickupNo: 'A01' });
  assert.equal(open.status, 200);
  const orderId = open.body.appended[0].orderId;
  const i1 = await cmd({ type: 'AddItem', orderId, name: '饭', qty: 1, windowId: 'A' });
  const i2 = await cmd({ type: 'AddItem', orderId, name: '汤', qty: 1, windowId: 'B' });
  const l1 = i1.body.appended[0].lineId, l2 = i2.body.appended[0].lineId;

  const p1 = await cmd({ type: 'PrepareItem', orderId, lineId: l1, expectedVersion: 1 });
  assert.equal(p1.status, 200);
  let snap = await (await fetch(`${base}/api/snapshot?date=${date}`)).json();
  assert.deepEqual(snap.ready, []);
  const rejected = await cmd({ type: 'ConfirmPickup', orderId });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.error, 'NOT_FULLY_PREPARED');

  await cmd({ type: 'PrepareItem', orderId, lineId: l2, expectedVersion: 1 });
  snap = await (await fetch(`${base}/api/snapshot?date=${date}`)).json();
  assert.equal(snap.ready.length, 1);
  assert.deepEqual(snap.ready[0].windows, ['A', 'B']);
  assert.equal(snap.ready[0].pickupNo, 'A01');

  const pickup = await cmd({ type: 'ConfirmPickup', orderId, by: 'staff' });
  assert.equal(pickup.status, 200);
  snap = await (await fetch(`${base}/api/snapshot?date=${date}`)).json();
  assert.deepEqual(snap.ready, []);

  // 已取餐后的迟到重做 -> 409，且无新事件
  const before = (await (await fetch(`${base}/api/events`)).json()).lastSeq;
  const late = await cmd({ type: 'RemakeItem', orderId, lineId: l1, expectedVersion: 2 });
  assert.equal(late.status, 409);
  assert.equal(late.body.error, 'ORDER_CLOSED');
  const after = (await (await fetch(`${base}/api/events`)).json()).lastSeq;
  assert.equal(before, after, '被拒绝的操作不产生事件');
});

test('幂等键：网络重试不重复出事件', async () => {
  const open = await cmd({ type: 'OpenOrder', businessDate: '2026-10-04', pickupNo: 'I01' }, 'k-open-1');
  const orderId = open.body.appended[0].orderId;
  const add = await cmd({ type: 'AddItem', orderId, name: '茶', qty: 1, windowId: 'A' });
  const lineId = add.body.appended[0].lineId;
  const before = (await (await fetch(`${base}/api/events`)).json()).lastSeq;
  const again = await cmd({ type: 'PrepareItem', orderId, lineId, expectedVersion: 1 }, 'k-prep-1');
  assert.equal(again.status, 200);
  const dup = await cmd({ type: 'PrepareItem', orderId, lineId, expectedVersion: 1 }, 'k-prep-1');
  assert.equal(dup.status, 200);
  assert.equal(dup.body.idempotent, true);
  const seqNow = (await (await fetch(`${base}/api/events`)).json()).lastSeq;
  assert.equal(seqNow, before + 1, '同一幂等键只追加一次');
});

test('取餐号跨日复用', async () => {
  const r1 = await cmd({ type: 'OpenOrder', businessDate: '2026-10-03', pickupNo: 'R08' });
  assert.equal(r1.status, 200);
  const r2 = await cmd({ type: 'OpenOrder', businessDate: '2026-10-04', pickupNo: 'R08' });
  assert.equal(r2.status, 200);
  const r3 = await cmd({ type: 'OpenOrder', businessDate: '2026-10-04', pickupNo: 'R08' });
  assert.equal(r3.status, 409);
  assert.equal(r3.body.error, 'PICKUP_NO_TAKEN');
});

test('SSE：实时 mutation 推送 + Last-Event-ID 断线补段', async () => {
  // 先开一单
  const open = await cmd({ type: 'OpenOrder', businessDate: '2026-10-04', pickupNo: 'S01' });
  const orderId = open.body.appended[0].orderId;

  // 建立 SSE，收集 1 条 mutation
  const got = new Promise((resolve) => {
    const ac = new AbortController();
    fetch(`${base}/api/events/stream`, { headers: { Accept: 'text/event-stream' }, signal: ac.signal })
      .then(async (r) => {
        const reader = r.body.getReader();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buf += Buffer.from(value).toString();
          if (buf.includes('event: mutation')) {
            const idm = buf.match(/^id: (\d+)/m);
            ac.abort();
            resolve(Number(idm[1]));
            return;
          }
        }
      });
  });
  await new Promise((r) => setTimeout(r, 200));
  const add = await cmd({ type: 'AddItem', orderId, name: '咖啡', qty: 1, windowId: 'A' });
  const liveSeq = await got;
  assert.equal(liveSeq, add.body.seq);

  // 模拟断线：带 Last-Event-ID 重连，应补到后续事件
  const add2 = await cmd({ type: 'AddItem', orderId, name: '蛋糕', qty: 1, windowId: 'B' });
  const resp = await fetch(`${base}/api/events/stream`, { headers: { 'Last-Event-ID': String(liveSeq) } });
  const reader = resp.body.getReader();
  const chunk = Buffer.from((await reader.read()).value).toString();
  assert.ok(chunk.includes('event: mutation'));
  assert.ok(chunk.includes(`"seq":${add2.body.seq}`) || chunk.includes(`"seq": ${add2.body.seq}`));
  reader.cancel();
});

test('SSE 缺口太旧 -> reset 事件触发整包补拉', async () => {
  // 环形窗口最早为 seq=1；请求 -1（早于窗口起点 first.seq-1=0）应给 reset
  const resp = await fetch(`${base}/api/events/stream`, { headers: { 'Last-Event-ID': '-1' } });
  const reader = resp.body.getReader();
  const chunk = Buffer.from((await reader.read()).value).toString();
  assert.ok(chunk.includes('event: reset'));
  reader.cancel();
});

test('宣传资源：正常可读；?broken=1 为 404（验收资源不可读降级）', async () => {
  const ok = await fetch(`${base}/promo.svg`);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /<svg/);
  const broken = await fetch(`${base}/promo.svg?broken=1`);
  assert.equal(broken.status, 404);
});

test('页面与健康检查可读，快照含数据时效字段', async () => {
  for (const p of ['/screen.html', '/kitchen.html', '/admin.html', '/js/common.js', '/css/style.css']) {
    const r = await fetch(`${base}${p}`);
    assert.equal(r.status, 200, p);
  }
  const h = await (await fetch(`${base}/api/health`)).json();
  assert.equal(h.ok, true);
  const snap = await (await fetch(`${base}/api/snapshot`)).json();
  assert.ok('serverTime' in snap && 'seq' in snap && Array.isArray(snap.ready));
});

test.after(() => { stop(); server.close(); });
