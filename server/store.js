// Append-only event store.
// 事实源：每条事件不可变，按全局 seq 单调递增。投影由事件折叠得到，
// 任何"订单状态"都不是被最后一条消息写出来的。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPLAY_RING = 500; // 内存中保留最近 N 条，供 SSE Last-Event-ID 增量补段

export class EventStore {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this._lock = Promise.resolve();
    this.ring = []; // 最近事件
    this.lastSeq = 0;
    this._fh = fs.openSync(file, 'a');
  }

  // 串行化临界区：命令处理的"读-校验-写"必须在同一把锁内完成
  withLock(fn) {
    const run = this._lock.then(() => fn());
    // 锁队列即使抛错也继续推进
    this._lock = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  append(event) {
    const rec = { seq: ++this.lastSeq, ts: Date.now(), ...event };
    fs.writeFileSync(this._fh, JSON.stringify(rec) + os.EOL);
    try { fs.fsyncSync(this._fh); } catch { /* 某些平台不支持 */ }
    this.ring.push(rec);
    if (this.ring.length > REPLAY_RING) this.ring.shift();
    return rec;
  }

  readAll() {
    if (!fs.existsSync(this.file)) return [];
    return fs
      .readFileSync(this.file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  // SSE 断线重连：用环形缓冲补齐 fromSeq 之后的事件；缺口太旧返回 null（调用方整包重拉）
  eventsAfter(fromSeq) {
    const first = this.ring[0];
    if (!first || fromSeq < first.seq - 1) return null;
    return this.ring.filter((e) => e.seq > fromSeq);
  }
}
