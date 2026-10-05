import path from 'node:path';
import { createApplication } from './app.js';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const eventFile = process.env.EVENT_FILE || path.resolve('data', 'events.jsonl');
const app = createApplication({ eventFile });

await app.store.load();
app.server.listen(port, host, () => {
  console.log(`餐厅取餐提醒系统已启动: http://${host}:${port}`);
  console.log(`事件日志: ${eventFile}`);
});

function shutdown(signal) {
  console.log(`${signal} 收到，正在关闭 HTTP 服务`);
  app.server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
