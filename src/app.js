import http from 'node:http';
import path from 'node:path';
import { EventStore, ValidationError, businessDate } from './store.js';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new ValidationError('PAYLOAD_TOO_LARGE', '请求体超过 1MB'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(new ValidationError('INVALID_JSON', `JSON 解析失败: ${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

function sseWrite(res, eventName, data) {
  if (res.writableEnded || res.destroyed) return false;
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(data).split('\n').join('\\n')}\n\n`);
  return true;
}

export function createApplication(options = {}) {
  const store = options.store || new EventStore(options.eventFile);
  const subscribers = new Set();
  let heartbeatTimer = null;

  function broadcast(envelope) {
    for (const client of subscribers) {
      if (!client.date || client.date === envelope.date) {
        sseWrite(client.res, 'event', envelope);
      }
    }
  }

  function startHeartbeat() {
    if (heartbeatTimer || subscribers.size === 0) return;
    heartbeatTimer = setInterval(() => {
      const snapshot = store.getSnapshot(businessDate());
      for (const client of subscribers) {
        sseWrite(client.res, 'heartbeat', {
          at: new Date().toISOString(),
          globalVersion: store.state.globalVersion,
          date: client.date || snapshot.date
        });
      }
    }, 15_000);
    heartbeatTimer.unref?.();
  }

  function stopHeartbeatIfIdle() {
    if (subscribers.size !== 0 || !heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  async function handleCommand(req, res, body) {
    try {
      const result = await store.command(body);
      const envelope = {
        type: 'order-event',
        date: result.order.date,
        event: result.event,
        order: result.order,
        transition: result.transition,
        snapshot: store.getSnapshot(result.order.date)
      };
      broadcast(envelope);
      sendJson(res, result.duplicate ? 200 : 201, {
        ok: true,
        duplicate: result.duplicate,
        event: result.event,
        order: result.order,
        transition: result.transition
      });
    } catch (error) {
      if (error instanceof ValidationError) {
        sendJson(res, 409, { ok: false, code: error.code, error: error.message, details: error.details });
      } else {
        throw error;
      }
    }
  }

  async function routeApi(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean);
    const date = url.searchParams.get('date') || businessDate();

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, at: new Date().toISOString(), globalVersion: store.state.globalVersion });
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      return sendJson(res, 200, store.getSnapshot(date));
    }

    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'orders' && parts[2]) {
      const order = store.getOrder(parts[2]);
      if (!order) return sendJson(res, 404, { ok: false, code: 'ORDER_NOT_FOUND', error: '订单不存在' });
      return sendJson(res, 200, order);
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      return sendJson(res, 200, {
        globalVersion: store.state.globalVersion,
        events: store.getEvents({
          date: url.searchParams.get('date') || undefined,
          orderId: url.searchParams.get('orderId') || undefined,
          after: Number(url.searchParams.get('after') || 0),
          limit: url.searchParams.get('limit') || 500
        })
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/transitions') {
      return sendJson(res, 200, {
        transitions: store.getTransitions({
          date: url.searchParams.get('date') || undefined,
          orderId: url.searchParams.get('orderId') || undefined,
          limit: url.searchParams.get('limit') || 500
        })
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/commands') {
      const body = await readJson(req);
      return handleCommand(req, res, body);
    }

    if (req.method === 'GET' && url.pathname === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      const clientDate = url.searchParams.get('date') || businessDate();
      const after = Number(url.searchParams.get('after') || 0);
      const client = { res, date: clientDate, createdAt: Date.now() };
      subscribers.add(client);
      sseWrite(res, 'hello', {
        at: new Date().toISOString(),
        globalVersion: store.state.globalVersion,
        date: clientDate
      });
      // 重连后先按版本号补段；客户端若发现缺口也可转用 snapshot 全量对齐。
      for (const event of store.getEvents({ after, date: clientDate, limit: 2000 })) {
        sseWrite(res, 'event', {
          type: 'order-event',
          event,
          order: store.getOrder(event.payload.orderId),
          replay: true
        });
      }
      sseWrite(res, 'snapshot', store.getSnapshot(clientDate));
      startHeartbeat();
      req.on('close', () => {
        subscribers.delete(client);
        stopHeartbeatIfIdle();
      });
      return undefined;
    }

    return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: 'API 路径不存在' });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        await store.load();
        await routeApi(req, res, url);
        return;
      }

      const publicRoot = path.resolve(new URL('../public/', import.meta.url).pathname);
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === '/') pathname = '/index.html';
      const normalized = path.resolve(publicRoot, `.${pathname}`);
      if (!normalized.startsWith(publicRoot + path.sep) && normalized !== publicRoot) {
        sendJson(res, 403, { ok: false, error: '禁止访问' });
        return;
      }
      const fs = await import('node:fs/promises');
      const data = await fs.readFile(normalized);
      const ext = path.extname(normalized).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300'
      });
      res.end(data);
    } catch (error) {
      if (error.code === 'ENOENT') {
        sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: '资源不存在' });
      } else {
        console.error(error);
        sendJson(res, 500, { ok: false, code: 'INTERNAL', error: '服务器内部错误' });
      }
    }
  });

  return {
    server,
    store,
    close: async () => {
      for (const client of subscribers) client.res.destroy();
      subscribers.clear();
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      await new Promise((resolve) => server.close(resolve));
    }
  };
}
