// 共享客户端基础设施：
//  - 以稳定 orderId 为身份的命令通道（取餐号可按营业日复用，不能做更新身份）
//  - SSE + Last-Event-ID 自动重连；事件连续->等折叠后补拉快照，缺段(gap)->立即整包补拉
//  - 心跳/在线状态推导数据时效；离线时禁止把缓存按钮当成中心确认
export const STALE_MS = 15000;
export const OFFLINE_MS = 35000;

export async function getJSON(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

export async function postCommand(payload) {
  // 每个意图一个幂等键：双击/网络重试不会产生重复事件
  const idem = `idem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const r = await fetch('/api/commands', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idem },
    body: JSON.stringify(payload)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data.message || `请求失败 ${r.status}`);
    err.code = data.error;
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data;
}

export function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}
export function fmtDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${d.toLocaleDateString('zh-CN')} ${fmtTime(ts)}`;
}

// 订阅模型。onSnapshot(snap) 每次补拉后调用；onStatus({online, stale, ageMs, gap}) 状态变化。
export function subscribe({ snapshotUrl, onSnapshot, onStatus, onGap }) {
  let lastSeq = 0;
  let lastDataAt = 0;
  let bootstrapped = false;
  let refreshTimer = null;
  let refreshing = false;
  let online = navigator.onLine;
  let es = null;

  async function refresh(reason) {
    if (refreshing) return;
    refreshing = true;
    try {
      const snap = await getJSON(snapshotUrl);
      const hadGap = snap.seq > lastSeq + 1 && bootstrapped;
      lastSeq = snap.seq;
      lastDataAt = Date.now();
      onSnapshot(snap, { first: !bootstrapped, reason, gap: hadGap });
      bootstrapped = true;
      if (hadGap && onGap) onGap(snap);
    } catch (e) {
      // 拉取失败：维持旧缓存展示，状态由心跳/在线检测转离线
      console.warn('snapshot refresh failed', e);
    } finally {
      refreshing = false;
    }
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refresh('mutation'), 60);
  }

  function connect() {
    es = new EventSource('/api/events/stream');
    es.addEventListener('mutation', (ev) => {
      const d = JSON.parse(ev.data);
      if (d.seq <= lastSeq) return;
      if (d.seq === lastSeq + 1) {
        lastSeq = d.seq;
        scheduleRefresh(); // 连续事件：折叠批次后一次补拉
      } else {
        // 缺段：不能按单条猜测状态，立即整包补拉
        lastSeq = d.seq;
        refresh('gap');
      }
    });
    es.addEventListener('reset', () => refresh('server-reset'));
    es.addEventListener('heartbeat', (ev) => {
      const d = JSON.parse(ev.data);
      lastDataAt = Date.now();
      if (d.seq > lastSeq) {
        lastSeq = d.seq;
        refresh('heartbeat-gap');
      }
    });
    es.onerror = () => { /* EventSource 会自动带 Last-Event-ID 重连 */ };
  }

  setInterval(() => {
    const age = Date.now() - lastDataAt;
    const isOnline = navigator.onLine && age < OFFLINE_MS;
    const stale = age > STALE_MS;
    if (isOnline !== online) {
      online = isOnline;
      if (isOnline) refresh('reconnected');
    }
    onStatus({ online: isOnline, stale, ageMs: age });
  }, 1000);

  window.addEventListener('online', () => refresh('online-event'));
  window.addEventListener('offline', () => {});

  refresh('bootstrap').then(connect);
  return { refresh: () => refresh('manual') };
}

export function dataAgeBadge(status, el) {
  if (!status.online) {
    el.textContent = '● 离线 · 缓存数据（非中心确认）';
    el.className = 'age-badge offline';
  } else if (status.stale) {
    el.textContent = `● 数据 ${Math.round(status.ageMs / 1000)} 秒未更新`;
    el.className = 'age-badge stale';
  } else {
    el.textContent = `● 实时 · ${Math.max(0, Math.round(status.ageMs / 1000))}s 前`;
    el.className = 'age-badge live';
  }
}
