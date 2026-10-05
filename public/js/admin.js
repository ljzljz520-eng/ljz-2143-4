import { api, connectSSE, esc, fmtAge, fmtTime, statusText, today } from './api.js';

const dateEl = document.querySelector('[data-date]');
const ordersEl = document.querySelector('[data-orders]');
const transitionsEl = document.querySelector('[data-transitions]');
const detailEl = document.querySelector('[data-detail]');
const selectEl = document.querySelector('[data-order-select]');
const gapEl = document.querySelector('[data-gap-result]');
dateEl.value = today();

let snapshot = { orders: [], globalVersion: 0, lastEventAt: null };
let transitions = [];
let heartbeatAt = null;

function renderOrders() {
  ordersEl.innerHTML = (snapshot.orders || []).map((order) => `
    <article class="order-card ${esc(order.status)}" style="margin-bottom:12px">
      <div class="order-head">
        <div><span class="pickup-no">${esc(order.pickupNo)}</span><span class="order-meta"> / ${esc(order.date)}</span></div>
        <span class="badge ${esc(order.status)}">${statusText(order.status)}</span>
      </div>
      <p class="order-meta">orderId: <span class="code">${esc(order.id)}</span></p>
      <div class="row" style="font-size:13px">
        <span>聚合版本 v${order.version}</span><span>可取顺序 #${order.readySequence ?? '—'}</span><span>窗口 ${(order.windows || []).map(esc).join(' / ')}</span>
      </div>
      <ul class="items">${order.items.map((item) => `<li class="item ${item.ready ? 'ready' : ''} ${item.canceled ? 'canceled' : ''}">
        <div><b>${esc(item.name)} ×${item.qty}</b><div class="item-sub">${esc(item.window)} · ${item.ready ? '可取' : item.canceled ? '取消' : '制作中'} · 明细 v${item.version}${item.remakeCount ? ` · 重做${item.remakeCount}` : ''}</div></div>
      </li>`).join('')}</ul>
    </article>`).join('') || '<p class="muted">无订单</p>';

  const selected = selectEl.value;
  selectEl.innerHTML = (snapshot.orders || []).map((order) => `<option value="${esc(order.id)}">${esc(order.pickupNo)} - ${esc(order.id.slice(0,8))}</option>`).join('');
  if ([...selectEl.options].some((option) => option.value === selected)) selectEl.value = selected;
  renderDetail();
}

function renderTransitions() {
  transitionsEl.innerHTML = transitions.slice().reverse().map((row) => `
    <tr>
      <td>${row.globalVersion}</td><td>${fmtTime(row.at)}</td>
      <td><b>${esc(row.pickupNo)}</b><br><span class="muted">${esc(row.date)}</span></td>
      <td><span class="badge">${esc(statusText(row.from))}</span> → <span class="badge ${esc(row.to)}">${esc(statusText(row.to))}</span></td>
      <td>#${row.readySequence ?? '—'}</td><td>${esc(row.by || '')}</td><td class="code">${esc(row.eventType)}</td>
      <td>${esc(row.reason || '')}</td><td class="code">${esc(row.orderId)}</td>
    </tr>`).join('') || '<tr><td colspan="9" class="muted">无状态转换</td></tr>';
}

function renderDetail() {
  const order = (snapshot.orders || []).find((item) => item.id === selectEl.value);
  if (!order) { detailEl.innerHTML = '<p class="muted">请选择订单</p>'; return; }
  detailEl.innerHTML = order.items.map((item) => `
    <div class="item" style="grid-template-columns:1fr;margin:8px 0">
      <div><b>${esc(item.name)}</b> <span class="muted">${esc(item.window)} 窗口 · 当前 v${item.version}</span></div>
      <table style="margin-top:8px"><thead><tr><th>v</th><th>动作</th><th>状态</th><th>时间</th><th>人</th><th>原因/事件</th></tr></thead>
      <tbody>${(item.history || []).map((history) => `<tr>
        <td>${history.globalVersion}</td><td>${esc(history.type)}</td><td>${esc(history.from)} → ${esc(history.to)}</td>
        <td>${fmtTime(history.at)}</td><td>${esc(history.by)}</td><td>${esc(history.reason)}<br><span class="code">${esc(history.eventId)}</span></td>
      </tr>`).join('')}</tbody></table>
    </div>`).join('');
}

async function load() {
  const date = dateEl.value;
  [snapshot, { transitions }] = await Promise.all([
    api(`/api/state?date=${encodeURIComponent(date)}`),
    api(`/api/transitions?date=${encodeURIComponent(date)}&limit=1000`)
  ]);
  renderOrders();
  renderTransitions();
  document.querySelector('[data-connection]').className = 'connection online';
  document.querySelector('[data-connection]').textContent = '中心连接正常';
  document.querySelector('[data-age]').textContent = `v${snapshot.globalVersion} · ${snapshot.lastEventAt ? `${fmtTime(snapshot.lastEventAt)}（${fmtAge(snapshot.lastEventAt)}）` : '无事件'}`;
}

connectSSE({
  date: () => dateEl.value,
  afterVersion: () => snapshot.globalVersion || 0,
  onSnapshot: load,
  onEvent: (envelope) => {
    if (!envelope.replay) load();
  },
  onStateChange: (state, at) => {
    const badge = document.querySelector('[data-connection]');
    badge.className = `connection ${state === 'online' ? 'online' : 'offline'}`;
    badge.textContent = state === 'online' ? '中心连接正常' : '断网/连接中断';
    if (state === 'online' && at) heartbeatAt = at;
    document.querySelector('[data-age]').textContent = state === 'online'
      ? `事件 ${snapshot.lastEventAt ? fmtAge(snapshot.lastEventAt) : '无'} · 心跳 ${heartbeatAt ? fmtAge(heartbeatAt) : '—'}`
      : `中心不可达，缓存数据 ${snapshot.lastEventAt ? fmtAge(snapshot.lastEventAt) : '无时间'}，可能过时`;
  }
});

selectEl.addEventListener('change', renderDetail);
dateEl.addEventListener('change', load);

document.querySelector('[data-fetch-events]').addEventListener('click', async () => {
  const after = Number(document.querySelector('[data-after]').value || 0);
  try {
    const data = await api(`/api/events?date=${encodeURIComponent(dateEl.value)}&after=${after}&limit=1000`);
    let expected = after;
    const gaps = [];
    for (const event of data.events) {
      if (event.globalVersion !== expected + 1) gaps.push(`${expected} → ${event.globalVersion}`);
      expected = event.globalVersion;
    }
    if (gaps.length) {
      gapEl.innerHTML = `<b style="color:var(--red)">检测到缺段：${gaps.map(esc).join('，')}。客户端不逐条猜测，改为拉取完整快照重放。</b>`;
      const full = await api(`/api/state?date=${encodeURIComponent(dateEl.value)}`);
      snapshot = full;
      renderOrders();
    } else {
      gapEl.textContent = `拉取 ${data.events.length} 条事件，版本连续；当前中心全局 v${data.globalVersion}。`;
    }
  } catch (error) {
    gapEl.textContent = `补拉失败：${error.message}`;
  }
});

load().catch((error) => {
  ordersEl.textContent = error.message;
});
