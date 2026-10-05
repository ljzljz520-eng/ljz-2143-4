import { connectSSE, esc, fmtAge, fmtTime, today } from './api.js';

const listEl = document.querySelector('[data-ready-list]');
const dateEl = document.querySelector('[data-date]');
const ageEl = document.querySelector('[data-age]');
const offlineWarning = document.querySelector('[data-offline-warning]');
const root = document.documentElement;
const body = document.body;
const promo = document.querySelector('[data-promo]');
const fallback = document.querySelector('[data-promo-fallback]');

dateEl.value = today();
let state = { date: dateEl.value, ready: [], orders: [], globalVersion: 0, lastEventAt: null };
let lastAt = null;
let heartbeatAt = null;
let offline = false;
let connection = null;
const seenVersions = new Set();
const announced = new Set();

function deriveReady() {
  return state.orders
    .filter((order) => order.date === state.date && order.status === 'ready')
    .sort((a, b) => (a.readySequence ?? Infinity) - (b.readySequence ?? Infinity));
}

function render(announceIds = []) {
  const ready = state.ready?.length ? state.ready : deriveReady();
  if (!ready.length) {
    listEl.innerHTML = '<div class="empty-ready">暂无可取号码<br><small>请耐心等待叫号</small></div>';
  } else {
    listEl.innerHTML = ready.map((order) => {
      const windows = (order.windows || []).map(esc).join(' / ');
      return `
        <article class="ready-number ${announceIds.includes(order.id) ? 'flash' : ''}" data-order-id="${esc(order.id)}">
          <div class="no">${esc(order.pickupNo)}</div>
          <div>
            <div class="windows">${windows || '取餐口'} 窗口</div>
            <div class="data-age">顺序 #${order.readySequence} · ${esc(state.date)} · ${fmtTime(order.readyAt)}</div>
          </div>
        </article>`;
    }).join('');
  }
  ageEl.textContent = offline
    ? `离线缓存：数据事件 #${state.globalVersion}，事件时间 ${lastAt ? `${fmtTime(lastAt)}（${fmtAge(lastAt)}）` : '未知'}；未获中心确认`
    : `中心数据：事件 #${state.globalVersion} · ${lastAt ? `${fmtTime(lastAt)}（${fmtAge(lastAt)}）` : '无事件'} · 心跳 ${heartbeatAt ? fmtAge(heartbeatAt) : '—'}`;
  offlineWarning.hidden = !offline;
  body.classList.toggle('screen-offline', offline);
}

function speak(order) {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(`请 ${order.pickupNo.split('').join(' ')} 号顾客到 C 窗口取餐`);
  utterance.lang = 'zh-CN';
  utterance.rate = 0.9;
  utterance.volume = 1;
  window.speechSynthesis.speak(utterance);
}

function mergeSnapshot(snapshot, options = {}) {
  const previousReady = new Map(deriveReady().map((order) => [order.id, order]));
  state = {
    date: snapshot.date,
    globalVersion: snapshot.globalVersion,
    lastEventAt: snapshot.lastEventAt,
    ready: snapshot.ready || [],
    orders: snapshot.orders || snapshot.ready || []
  };
  lastAt = snapshot.lastEventAt || lastAt;
  heartbeatAt = heartbeatAt || new Date().toISOString();
  const newReadyIds = [];
  for (const order of state.ready || []) {
    if (!previousReady.has(order.id) && !options.silent) newReadyIds.push(order.id);
  }
  render(newReadyIds);
  if (!options.silent) {
    for (const order of state.ready || []) {
      if (newReadyIds.includes(order.id) && !announced.has(order.id)) {
        announced.add(order.id);
        speak(order);
      }
    }
  }
  // 快照是权威版本；其中所有 ready 都视为历史，后续重启/补拉不重播。
  for (const order of state.ready || []) announced.add(order.id);
}

function mergeLive(envelope) {
  const { event, order, transition, snapshot } = envelope;
  if (event.payload.date !== state.date) return;
  if (seenVersions.has(event.globalVersion)) return;
  if (event.globalVersion !== state.globalVersion + 1) {
    // 缺段：不拿单事件猜状态，拉取完整投影补齐；补拉不补播旧号码。
    fetch(`/api/state?date=${encodeURIComponent(state.date)}`)
      .then((res) => res.json())
      .then((data) => mergeSnapshot(data, { silent: true }))
      .catch(() => render());
    return;
  }
  seenVersions.add(event.globalVersion);
  if (snapshot) {
    mergeSnapshot(snapshot, { silent: true });
  } else {
    const idx = state.orders.findIndex((item) => item.id === order.id);
    if (idx >= 0) state.orders[idx] = order;
    else state.orders.push(order);
    state.ready = deriveReady();
    state.globalVersion = event.globalVersion;
    state.lastEventAt = event.at;
    render();
  }
  // 只对实时发生的 preparing -> ready 转换播报；replay/catch-up/snapshot 永远静音。
  if (transition?.from === 'preparing' && transition.to === 'ready') {
    announced.add(order.id);
    render([order.id]);
    speak(order);
  }
}

function setConnection(status, at, reason = '') {
  const wasOffline = offline;
  offline = status !== 'online';
  if (status === 'online' && at) heartbeatAt = at;
  const badge = document.querySelector('[data-connection]');
  badge.className = `connection ${status === 'online' ? 'online' : 'offline'}`;
  badge.textContent = status === 'online' ? '中心连接正常' : '断网/连接中断';
  if (status === 'online' && wasOffline) {
    fetch(`/api/state?date=${encodeURIComponent(state.date)}`)
      .then((res) => res.json())
      .then((data) => mergeSnapshot(data, { silent: true }))
      .catch(() => render());
  }
  render();
}

fetch(`/api/state?date=${encodeURIComponent(dateEl.value)}`)
  .then((res) => {
    if (!res.ok) throw new Error('state failed');
    return res.json();
  })
  .then((data) => {
    mergeSnapshot(data, { silent: true });
    for (const event of data.ready || []) seenVersions.add(event.version);
    // 初始化已完成号码只记录，不重复播报历史。
    for (const order of data.ready || []) announced.add(order.id);
    render();
  })
  .catch(() => {
    offline = true;
    render();
  });

connection = connectSSE({
  date: () => dateEl.value,
  afterVersion: () => state.globalVersion,
  onSnapshot: (snapshot) => mergeSnapshot(snapshot, { silent: true }),
  onEvent: (envelope) => {
    if (!envelope.replay) mergeLive(envelope);
  },
  onStateChange: setConnection
});

dateEl.addEventListener('change', () => {
  connection.close();
  state = { date: dateEl.value, ready: [], orders: [], globalVersion: 0, lastEventAt: null };
  lastAt = null;
  heartbeatAt = null;
  seenVersions.clear();
  announced.clear();
  offline = false;
  fetch(`/api/state?date=${encodeURIComponent(dateEl.value)}`)
    .then((res) => res.json())
    .then((data) => mergeSnapshot(data, { silent: true }))
    .finally(() => {
      connection = connectSSE({
        date: () => dateEl.value,
        afterVersion: () => state.globalVersion,
        onSnapshot: (snapshot) => mergeSnapshot(snapshot, { silent: true }),
        onEvent: (envelope) => { if (!envelope.replay) mergeLive(envelope); },
        onStateChange: setConnection
      });
    });
});

document.querySelector('[data-test-voice]').addEventListener('click', () => {
  const first = state.ready?.[0];
  if (first) speak(first);
  else speak({ pickupNo: '101' });
});

promo.addEventListener('error', () => {
  promo.hidden = true;
  fallback.hidden = false;
}, { once: true });

function applyPresentation(full, source) {
  body.classList.toggle('screen-fullscreen', full);
  root.style.colorScheme = full ? 'dark' : 'light dark';
  promo.src = source || (full ? '/promo-night.svg' : '/promo.svg');
  promo.hidden = false;
  fallback.hidden = true;
}

document.querySelector('[data-fullscreen]').addEventListener('click', async () => {
  if (!document.documentElement.requestFullscreen || !document.exitFullscreen) {
    applyPresentation(!body.classList.contains('screen-fullscreen'));
    return;
  }
  try {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
    } else {
      await document.exitFullscreen();
    }
  } catch (error) {
    // 浏览器拒绝全屏时仍切换演示样式，背景和宣传图也必须更换。
    applyPresentation(!body.classList.contains('screen-fullscreen'));
  }
});

document.addEventListener('fullscreenchange', () => {
  applyPresentation(Boolean(document.fullscreenElement));
});

setInterval(() => render(), 1000);
