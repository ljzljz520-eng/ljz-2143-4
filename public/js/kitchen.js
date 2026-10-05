import { api, command, connectSSE, esc, fmtAge, fmtTime, itemStatus, statusText, today, toast, uid } from './api.js';

const dateEl = document.querySelector('[data-date]');
const operatorEl = document.querySelector('[data-operator]');
const ordersEl = document.querySelector('[data-orders]');
const itemRowsEl = document.querySelector('[data-item-rows]');
const offlineWarning = document.querySelector('[data-offline-warning]');
dateEl.value = today();
operatorEl.value = localStorage.getItem('operator') || '后厨A';

let snapshot = { orders: [], ready: [], globalVersion: 0, lastEventAt: null };
let lastHeartbeatAt = null;
let offline = false;
let sse = null;

function by() {
  localStorage.setItem('operator', operatorEl.value || '后厨');
  return operatorEl.value || '后厨';
}

function addCreateRow(prefill = {}) {
  const row = document.createElement('div');
  row.className = 'field';
  row.innerHTML = `
    <label>菜名 <input data-name value="${esc(prefill.name || '')}" required maxlength="80"></label>
    <label>数量 <input data-qty type="number" min="1" max="99" value="${Number(prefill.qty || 1)}"></label>
    <label>窗口 <input data-window value="${esc(prefill.window || 'A')}" maxlength="8"></label>
    <label>备注 <input data-notes value="${esc(prefill.notes || '')}" maxlength="240"></label>
    <button type="button" class="small red" data-remove-row>删除</button>`;
  itemRowsEl.appendChild(row);
}
addCreateRow({ window: 'A' });
addCreateRow({ window: 'B' });

document.querySelector('[data-add-row]').addEventListener('click', () => addCreateRow());
itemRowsEl.addEventListener('click', (event) => {
  if (event.target.matches('[data-remove-row]')) event.target.closest('.field').remove();
});

document.querySelector('[data-create-form]').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (offline) return toast('断网中：不能向中心创建订单', 'error');
  const form = event.currentTarget;
  const rows = [...itemRowsEl.children].map((row) => ({
    id: uid('item'),
    name: row.querySelector('[data-name]').value.trim(),
    qty: Number(row.querySelector('[data-qty]').value),
    window: row.querySelector('[data-window]').value.trim().toUpperCase(),
    notes: row.querySelector('[data-notes]').value.trim()
  })).filter((item) => item.name);
  if (!rows.length) return toast('至少输入一个明细', 'error');
  try {
    const body = {
      date: dateEl.value,
      by: by(),
      items: rows,
      note: new FormData(form).get('note') || ''
    };
    const pickupNo = form.querySelector('[name=pickupNo]').value.trim();
    const orderId = form.querySelector('[name=orderId]').value.trim();
    if (pickupNo) body.pickupNo = pickupNo;
    if (orderId) body.orderId = orderId;
    const result = await command('create-order', body);
    toast(`订单 ${result.order.pickupNo} 已创建，仅所有窗口齐餐后才可取`, 'success');
    form.reset();
    itemRowsEl.innerHTML = '';
    addCreateRow({ window: 'A' });
    addCreateRow({ window: 'B' });
    form.querySelector('[name=pickupNo]').value = '';
    form.querySelector('[name=orderId]').value = '';
  } catch (error) {
    toast(`${error.message}${error.code ? `（${error.code}）` : ''}`, 'error', 6000);
  }
});

function renderOrder(order) {
  const readyWindows = new Set(order.items.filter((item) => item.ready && !item.canceled).map((item) => item.window));
  const itemHtml = order.items.map((item) => `
    <li class="item ${item.ready ? 'ready' : ''} ${item.canceled ? 'canceled' : ''}">
      <div>
        <div class="item-name">${esc(item.name)} ×${item.qty} <span class="badge">${esc(item.window)} 窗口</span></div>
        <div class="item-sub">${esc(itemStatus(item))}${item.remakeCount ? ` · 重做 ${item.remakeCount} 次` : ''}${item.notes ? ` · ${esc(item.notes)}` : ''}</div>
        <div class="item-sub code">itemId: ${esc(item.id)}</div>
      </div>
      <div class="item-actions">
        ${!item.canceled && !item.ready && order.status !== 'picked' ? `<button class="small green" data-action="complete" data-item="${esc(item.id)}" data-version="${item.version}" ${offline ? 'disabled' : ''}>完成</button>` : ''}
        ${!item.canceled && item.ready && order.status !== 'picked' ? `<button class="small orange" data-action="undo" data-item="${esc(item.id)}" data-version="${item.version}" ${offline ? 'disabled' : ''}>撤销</button>` : ''}
        ${!item.canceled && item.ready && order.status !== 'picked' ? `<button class="small orange" data-action="remake" data-item="${esc(item.id)}" data-version="${item.version}" ${offline ? 'disabled' : ''}>重做</button>` : ''}
        ${!item.canceled && order.status !== 'picked' ? `<button class="small red" data-action="cancel" data-item="${esc(item.id)}" data-version="${item.version}" ${offline ? 'disabled' : ''}>取消</button>` : ''}
      </div>
    </li>`).join('');
  const canPickup = order.status === 'ready';
  return `
    <article class="order-card ${esc(order.status)}" data-order-id="${esc(order.id)}">
      <div class="order-head">
        <div><div class="pickup-no">${esc(order.pickupNo)}</div><div class="order-meta">#${order.readySequence ?? '—'} · ${esc(order.date)}</div></div>
        <span class="badge ${esc(order.status)}">${statusText(order.status)}</span>
      </div>
      <div class="order-meta">窗口：${(order.windows || []).map(esc).join(' / ')} · 已完成窗口：${readyWindows.size ? [...readyWindows].map(esc).join(' / ') : '无'}</div>
      <ul class="items">${itemHtml}</ul>
      <div class="row">
        <button class="green" data-action="pickup" ${!canPickup || offline ? 'disabled' : ''}>中心确认取餐</button>
        <button class="secondary" data-action="add" ${order.status === 'picked' || offline ? 'disabled' : ''}>追加菜</button>
      </div>
      <div class="statusline">创建 ${fmtTime(order.createdAt)} · 更新 ${fmtTime(order.updatedAt)}${order.pickedAt ? ` · 取餐 ${fmtTime(order.pickedAt)}` : ''}</div>
    </article>`;
}

function render() {
  const orders = [...(snapshot.orders || [])].sort((a, b) => {
    const rank = { preparing: 0, ready: 1, picked: 2, empty: 3 };
    const diff = rank[a.status] - rank[b.status];
    return diff || new Date(a.createdAt) - new Date(b.createdAt);
  });
  ordersEl.innerHTML = orders.length ? orders.map(renderOrder).join('') : '<p class="muted">当前营业日暂无订单。</p>';
  offlineWarning.hidden = !offline;
  document.querySelectorAll('button[data-action]').forEach((button) => {
    if (offline) button.disabled = true;
  });
  const badge = document.querySelector('[data-connection]');
  badge.className = `connection ${offline ? 'offline' : 'online'}`;
  badge.textContent = offline ? '断网/连接中断' : '中心连接正常';
  const age = document.querySelector('[data-age]');
  age.textContent = `v${snapshot.globalVersion || 0} · ${snapshot.lastEventAt ? fmtTime(snapshot.lastEventAt) : '无事件'} · ${offline ? `缓存 ${snapshot.lastEventAt ? fmtAge(snapshot.lastEventAt) : ''}` : `心跳 ${lastHeartbeatAt ? fmtAge(lastHeartbeatAt) : '—'}`}`;
}

async function loadSnapshot(silent = false) {
  try {
    snapshot = await api(`/api/state?date=${encodeURIComponent(dateEl.value)}`);
    offline = false;
    render();
  } catch (error) {
    offline = true;
    render();
    if (!silent) toast('无法从中心拉取订单，按钮已禁用', 'error');
  }
}

async function runAction(action, orderId, itemId, version) {
  const map = {
    complete: ['complete-item', '明细已完成'],
    undo: ['undo-item', '已撤销完成'],
    cancel: ['cancel-item', '明细已取消'],
    remake: ['remake-item', '该明细已进入重做']
  };
  if (map[action]) {
    const reason = action === 'remake' ? prompt('请输入重做原因（可留空）', '品质返工') : '';
    if (action === 'remake' && reason === null) return;
    const [type, message] = map[action];
    await command(type, { orderId, itemId, expectedVersion: version, by: by(), reason });
    toast(message, 'success');
  }
}

ordersEl.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  if (offline) return toast('断网中：所有中心操作已禁用', 'error');
  const card = button.closest('[data-order-id]');
  const orderId = card.dataset.orderId;
  const action = button.dataset.action;
  try {
    if (action === 'pickup') {
      await command('confirm-pickup', { orderId, by: by() });
      toast('中心已确认取餐，顾客屏移除号码', 'success');
    } else if (action === 'add') {
      const name = prompt('追加菜名称');
      if (!name) return;
      const windowName = (prompt('出餐窗口', 'A') || 'A').toUpperCase();
      await command('add-item', {
        orderId,
        by: by(),
        item: { id: uid('item'), name, qty: 1, window: windowName }
      });
      toast('追加菜已作为新明细版本写入事件', 'success');
    } else {
      await runAction(action, orderId, button.dataset.item, Number(button.dataset.version));
    }
    await loadSnapshot(true);
  } catch (error) {
    if (error.code === 'ITEM_VERSION_CONFLICT') {
      toast(`版本冲突：${error.message}；已为你刷新，请勿重复旧按钮`, 'error', 7000);
    } else {
      toast(`${error.message}${error.code ? `（${error.code}）` : ''}`, 'error', 6500);
    }
    await loadSnapshot(true);
  }
});

function connect() {
  sse?.close();
  sse = connectSSE({
    date: () => dateEl.value,
    afterVersion: () => snapshot.globalVersion || 0,
    onSnapshot: (data) => { snapshot = data; offline = false; render(); },
    onEvent: (envelope) => {
      if (envelope.replay) return;
      if (envelope.snapshot) snapshot = envelope.snapshot;
      else if (envelope.order) {
        const idx = snapshot.orders.findIndex((order) => order.id === envelope.order.id);
        if (idx >= 0) snapshot.orders[idx] = envelope.order;
        else snapshot.orders.push(envelope.order);
      }
      snapshot.globalVersion = envelope.event.globalVersion;
      snapshot.lastEventAt = envelope.event.at;
      offline = false;
      render();
    },
    onStateChange: (state, at) => {
      offline = state !== 'online';
      if (state === 'online' && at) lastHeartbeatAt = at;
      render();
      if (state === 'online') loadSnapshot(true);
    }
  });
}

dateEl.addEventListener('change', () => loadSnapshot().then(connect));
operatorEl.addEventListener('change', by);
await loadSnapshot();
connect();
