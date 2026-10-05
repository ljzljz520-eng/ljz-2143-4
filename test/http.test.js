import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createApplication } from '../src/app.js';
import { businessDate } from '../src/store.js';

async function start() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pickup-http-'));
  const app = createApplication({ eventFile: path.join(dir, 'events.jsonl') });
  await app.store.load();
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const request = async (pathname, options = {}) => {
    const res = await fetch(`${base}${pathname}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options
    });
    const body = await res.json();
    return { res, body };
  };
  return { app, base, request };
}

test('HTTP 验收：双窗口、迟到重做、事件缺段补拉和静态高对比资源', async () => {
  const { app, base, request } = await start();
  try {
    const date = businessDate();
    const orderId = crypto.randomUUID();
    const create = await request('/api/commands', {
      method: 'POST',
      body: JSON.stringify({
        type: 'create-order', date, orderId, pickupNo: '888',
        items: [
          { id: 'i-a', name: '双窗口菜 A', qty: 1, window: 'A' },
          { id: 'i-b', name: '双窗口菜 B', qty: 1, window: 'B' }
        ]
      })
    });
    assert.equal(create.res.status, 201);
    assert.equal(create.body.order.status, 'preparing');

    const completeA = await request('/api/commands', {
      method: 'POST',
      body: JSON.stringify({ type: 'complete-item', date, orderId, itemId: 'i-a', expectedVersion: 1 })
    });
    let state = await request(`/api/state?date=${date}`);
    assert.equal(completeA.body.order.status, 'preparing');
    assert.equal(state.body.ready.length, 0);

    const completeB = await request('/api/commands', {
      method: 'POST',
      body: JSON.stringify({ type: 'complete-item', date, orderId, itemId: 'i-b', expectedVersion: 1 })
    });
    assert.equal(completeB.body.order.status, 'ready');
    assert.equal(completeB.body.transition.from, 'preparing');
    state = await request(`/api/state?date=${date}`);
    assert.deepEqual(state.body.ready.map((order) => order.pickupNo), ['888']);

    const pickup = await request('/api/commands', {
      method: 'POST',
      body: JSON.stringify({ type: 'confirm-pickup', date, orderId, idempotencyKey: 'pickup-888' })
    });
    assert.equal(pickup.body.order.status, 'picked');

    const lateRemake = await request('/api/commands', {
      method: 'POST',
      body: JSON.stringify({ type: 'remake-item', date, orderId, itemId: 'i-a', expectedVersion: 2 })
    });
    assert.equal(lateRemake.res.status, 409);
    assert.equal(lateRemake.body.code, 'ORDER_LOCKED');

    const noPickupOnly = await request('/api/orders/not-a-stable-id');
    assert.equal(noPickupOnly.res.status, 404);

    const events = await request(`/api/events?date=${date}&after=0`);
    assert.equal(events.body.events.length, 4);
    for (let i = 1; i < events.body.events.length; i += 1) {
      assert.equal(events.body.events[i].globalVersion, events.body.events[i - 1].globalVersion + 1);
    }
    const gap = await request(`/api/events?date=${date}&after=2`);
    assert.ok(gap.body.events[0].globalVersion === 3);

    const transitions = await request(`/api/transitions?date=${date}`);
    assert.deepEqual(transitions.body.transitions.map((row) => `${row.from}-${row.to}`), [
      'none-preparing', 'preparing-ready', 'ready-picked'
    ]);

    const page = await fetch(`${base}/screen.html`);
    assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
    const html = await page.text();
    assert.match(html, /无法连接中心|断网/);
    assert.match(html, /data-age/);
    assert.doesNotMatch(html, /<button[^>]*confirm/i);

    const promo = await fetch(`${base}/promo.svg`);
    assert.equal(promo.status, 200);
    assert.equal(promo.headers.get('content-type'), 'image/svg+xml; charset=utf-8');

    const css = await (await fetch(`${base}/styles.css`)).text();
    assert.match(css, /prefers-contrast: more/);
  } finally {
    await app.close();
  }
});

test('无 orderId 的更新被拒绝，跨日期同取餐号互不串单', async () => {
  const { app, request } = await start();
  try {
    const today = businessDate();
    const yesterday = businessDate(new Date(Date.now() - 86_400_000));
    await request('/api/commands', { method: 'POST', body: JSON.stringify({
      type: 'create-order', date: yesterday, pickupNo: '777', items: [{ id: 'old', name: '旧', window: 'A' }]
    }) });
    const current = await request('/api/commands', { method: 'POST', body: JSON.stringify({
      type: 'create-order', date: today, pickupNo: '777', items: [{ id: 'new', name: '新', window: 'A' }]
    }) });
    assert.equal(current.res.status, 201);

    const missing = await request('/api/commands', { method: 'POST', body: JSON.stringify({
      type: 'complete-item', date: today, itemId: 'new', expectedVersion: 1
    }) });
    assert.equal(missing.res.status, 409);
    assert.equal(missing.body.code, 'ORDER_ID_REQUIRED');

    const wrongDate = await request('/api/commands', { method: 'POST', body: JSON.stringify({
      type: 'complete-item', orderId: current.body.order.id, date: yesterday, itemId: 'new', expectedVersion: 1
    }) });
    assert.equal(wrongDate.body.code, 'DATE_MISMATCH');
  } finally {
    await app.close();
  }
});

test('SSE 重放事件后发送当天快照，重启客户端可恢复顺序', async () => {
  const { app } = await start();
  try {
    const date = businessDate();
    const first = await fetch(`http://127.0.0.1:${app.server.address().port}/api/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'create-order', date, pickupNo: '901', items: [{ id: 'one', name: '一', window: 'A' }] })
    }).then((res) => res.json());
    await fetch(`http://127.0.0.1:${app.server.address().port}/api/commands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'complete-item', date, orderId: first.order.id, itemId: 'one', expectedVersion: 1 })
    });

    const stream = await fetch(`http://127.0.0.1:${app.server.address().port}/api/stream?date=${date}&after=0`);
    const reader = stream.body.getReader();
    const chunks = [];
    let text = '';
    while (!text.includes('event: snapshot')) {
      const result = await reader.read();
      if (result.done) break;
      text += Buffer.from(result.value).toString('utf8');
    }
    assert.match(text, /event: hello/);
    assert.match(text, /event: event/);
    assert.match(text, /event: snapshot/);
    assert.match(text, /"pickupNo":"901"/);
    assert.match(text, /"readySequence":1/);
    await reader.cancel();
  } finally {
    await app.close();
  }
});
