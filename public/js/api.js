export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    const error = new Error(body.error || `请求失败 (${res.status})`);
    error.code = body.code;
    error.details = body.details;
    throw error;
  }
  return body;
}

export function command(type, payload) {
  return api('/api/commands', {
    method: 'POST',
    body: JSON.stringify({
      type,
      date: selectedDate(),
      idempotencyKey: crypto.randomUUID(),
      ...payload
    })
  });
}

export function selectedDate() {
  return document.querySelector('[data-date]')?.value || today();
}

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

export function uid(prefix = 'cli') {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function toast(message, kind = 'info', timeout = 4200) {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  document.body.appendChild(node);
  setTimeout(() => node.remove(), timeout);
  return node;
}

export function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });
}

export function fmtAge(iso) {
  if (!iso) return '无中心时间';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒前`;
  return `${Math.floor(minutes / 60)} 小时前`;
}

export function statusText(status) {
  return {
    preparing: '制作中',
    ready: '可取餐',
    picked: '已取餐',
    empty: '已全部取消'
  }[status] || status;
}

export function itemStatus(item) {
  if (item.canceled) return '已取消';
  if (item.ready) return `可取 v${item.version}`;
  return `制作中 v${item.version}`;
}

export function updateConnection(state, lastAt, offlineReason = '') {
  const badge = document.querySelector('[data-connection]');
  const age = document.querySelector('[data-age]');
  if (badge) {
    badge.classList.toggle('online', state === 'online');
    badge.classList.toggle('offline', state !== 'online');
    badge.textContent = state === 'online' ? '中心连接正常' : '断网/连接中断';
  }
  if (age && lastAt) {
    const seconds = Math.max(0, Math.round((Date.now() - new Date(lastAt).getTime()) / 1000));
    age.textContent = `数据时间 ${fmtTime(lastAt)} · 已 ${seconds} 秒未更新${offlineReason ? ` · ${offlineReason}` : ''}`;
  } else if (age) {
    age.textContent = '尚未收到中心数据';
  }
}

export function connectSSE({ date, afterVersion = () => 0, onSnapshot, onEvent, onStateChange }) {
  let closed = false;
  let source = null;
  let retry = 800;
  let timer = null;

  const mark = (state, at, reason) => onStateChange?.(state, at, reason);

  async function reconnect() {
    if (closed || source) return;
    mark('connecting', undefined, '正在建立连接');
    // EventSource 自身也会重连；这里显式重建以便切换日期/异常后恢复。
    const currentVersion = Number(afterVersion?.() || 0);
    source = new EventSource(`/api/stream?date=${encodeURIComponent(date())}&after=${currentVersion}`);
    source.addEventListener('hello', () => mark('online', new Date().toISOString()));
    source.addEventListener('heartbeat', (ev) => {
      const data = JSON.parse(ev.data);
      mark('online', data.at);
    });
    source.addEventListener('snapshot', (ev) => {
      const data = JSON.parse(ev.data);
      mark('online', data.lastEventAt || new Date().toISOString());
      onSnapshot(data, { replay: true });
    });
    source.addEventListener('event', (ev) => {
      const data = JSON.parse(ev.data);
      mark('online', data.event.at);
      onEvent(data);
    });
    source.onerror = () => {
      source?.close();
      source = null;
      mark('offline', undefined, '等待中心重连');
      clearTimeout(timer);
      timer = setTimeout(reconnect, retry);
      retry = Math.min(retry * 2, 10000);
    };
    source.onopen = () => { retry = 800; };
  }

  reconnect();
  return {
    close() {
      closed = true;
      clearTimeout(timer);
      source?.close();
    },
    reconnect
  };
}
