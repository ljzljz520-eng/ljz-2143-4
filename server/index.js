import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventStore } from './store.js';
import { fold, snapshot, adminSnapshot } from './projection.js';
import { CommandBus, newState } from './commands.js';
import { SseHub } from './sse.js';
import { promoSvg } from './promo.js';
import { businessDateFor } from './clock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');
const DATA = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'events.jsonl');
const PORT = Number(process.env.PORT || 8080);

// ---- 启动：重放全部事件，恢复相同顺序 ----
const store = new EventStore(DATA);
const state = fold(store.readAll(), newState());
const bus = new CommandBus(store, state, businessDateFor);
const hub = new SseHub(store);
const heartbeat = hub.startHeartbeat(() => state.seq);

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
};

const serveStatic = (req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/screen.html';
  const file = path.normalize(path.join(PUBLIC, urlPath));
  if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return json(res, 404, { error: 'not found' });
    const ext = path.extname(file);
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(buf);
  });
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  // 宣传图：?broken=1 模拟资源不可读
  if (p === '/promo.svg') {
    if (url.searchParams.get('broken')) return res.writeHead(404).end('not found');
    res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(promoSvg(url.searchParams.get('fullscreen') === '1'));
  }

  if (p === '/api/health') return json(res, 200, { ok: true, seq: state.seq, businessDate: businessDateFor(), serverTime: Date.now() });

  if (p === '/api/events/stream') {
    hub.attach(req, res);
    return;
  }

  if (p === '/api/snapshot') {
    const date = url.searchParams.get('date') || businessDateFor();
    return json(res, 200, snapshot(state, { businessDate: date }));
  }

  if (p === '/api/admin/snapshot') return json(res, 200, adminSnapshot(state));

  if (p === '/api/events') {
    const after = Number(url.searchParams.get('after') || 0);
    const all = store.readAll();
    return json(res, 200, {
      lastSeq: state.seq,
      events: after ? all.filter((e) => e.seq > after) : all
    });
  }

  if (p === '/api/rejections') return json(res, 200, { rejections: bus.rejections });

  if (p === '/api/commands' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { return json(res, 400, { error: 'invalid json' }); }
      try {
        const out = await bus.exec(body, req.headers['idempotency-key']);
        // 幂等重试（out.idempotent）不重复广播；新追加事件直接从返回值广播
        if (!out.idempotent) for (const ev of out.appended) hub.publish(ev);
        return json(res, 200, out);
      } catch (err) {
        if (err.status) return json(res, err.status, { error: err.code, message: err.message, ...err.extra });
        console.error(err);
        return json(res, 500, { error: 'INTERNAL', message: String(err.message || err) });
      }
    });
    return;
  }

  if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' });
  return serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`取餐系统已启动： http://localhost:${PORT}/screen.html   后厨 /kitchen.html   管理 /admin.html`);
});

function shutdown() {
  stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
function stop() {
  clearInterval(heartbeat);
  for (const c of hub.clients) c.res.destroy();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { server, bus, store, state, stop };
