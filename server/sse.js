// SSE 集线器：
//  - 每条写入事件广播 mutation（携带 seq）；另有 heartbeat 携带最新 seq
//  - 客户端比对 seq：连续（已补齐）就增量处理；出现缺段（gap）则整包补拉快照
//  - 重连带 Last-Event-ID 时，优先从环形缓冲补发缺段；缺口太旧返回 reset 事件触发整包重拉
export class SseHub {
  constructor(store) {
    this.store = store;
    this.clients = new Set();
  }

  attach(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(': connected\n\n');

    const lastId = Number(req.headers['last-event-id'] || 0);
    const backfill = lastId ? this.store.eventsAfter(lastId) : null;
    if (lastId && backfill === null) {
      res.write(`event: reset\ndata: ${JSON.stringify({ reason: 'gap-too-old' })}\n\n`);
    } else if (backfill && backfill.length) {
      for (const ev of backfill) res.write(this._format(ev));
    }

    const client = { res };
    this.clients.add(client);
    req.on('close', () => this.clients.delete(client));
    return client;
  }

  _format(ev) {
    return `id: ${ev.seq}\nevent: mutation\ndata: ${JSON.stringify({ seq: ev.seq, type: ev.type, orderId: ev.orderId })}\n\n`;
  }

  publish(ev) {
    const frame = this._format(ev);
    for (const c of this.clients) c.res.write(frame);
  }

  startHeartbeat(seqRef) {
    return setInterval(() => {
      const frame = `event: heartbeat\ndata: ${JSON.stringify({ seq: seqRef(), ts: Date.now() })}\n\n`;
      for (const c of this.clients) c.res.write(frame);
    }, 15000);
  }
}
