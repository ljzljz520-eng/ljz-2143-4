// 后厨端：所有更新都以 orderId（稳定身份）定位，取餐号仅展示。
// 每个明细携带当前 version，修改时带 expectedVersion，冲突时以服务端快照为准。
const cardsEl = document.getElementById('cards');
const ageEl = document.getElementById('age');
const addOrderSel = document.getElementById('add-order');
let snap = null;

function toast(msg, kind = '') {
  const d = document.createElement('div');
  d.className = `toast ${kind}`;
  d.textContent = msg;
  document.getElementById('toasts').appendChild(d);
  setTimeout(() => d.remove(), 4200);
}

async function send(payload, okMsg) {
  try {
    await postCommand(payload);
    toast(okMsg || '已提交', 'ok');
    await api.refresh();
  } catch (e) {
    toast(`被拒绝：${e.message}${e.code === 'VERSION_CONFLICT' ? '（状态已变更，已为你刷新）' : ''}`, 'err');
    if (e.status === 409) api.refresh();
  }
}

function orderBadge(o) {
  if (o.allDone) return '<span class="badge ready">待取餐（双窗口已齐）</span>';
  const partial = o.windows.some((w) => w.done > 0);
  return `<span class="badge ${partial ? 'done' : 'prepping'}">${partial ? '部分完成 · 制作中' : '制作中'}</span>`;
}

function render() {
  if (!snap) return;
  const orders = snap.making;
  addOrderSel.innerHTML = orders.map((o) => `<option value="${o.orderId}">${o.pickupNo}</option>`).join('');
  document.getElementById('making-title').textContent = `制作中 / 待取餐（${orders.length} 单）`;
  cardsEl.innerHTML = '';

  for (const o of orders) {
    const card = document.createElement('div');
    card.className = 'card';
    const winLine = o.windows.map((w) => `窗口${w.windowId} ${w.done}/${w.total}`).join('　');
    card.innerHTML = `<h3>取餐号 ${o.pickupNo} ${orderBadge(o)}
        <button class="confirm action" data-act="pickup" ${o.allDone ? '' : 'disabled'}
          title="${o.allDone ? '确认取餐' : '部分完成不能取餐'}">确认取餐</button></h3>
      <div class="wprogress">${winLine}${o.note ? '　备注：' + escapeHtml(o.note) : ''}</div>`;

    for (const l of o.lines) {
      const row = document.createElement('div');
      row.className = 'line-row';
      row.innerHTML = `<span class="lname">${l.qty}× ${escapeHtml(l.name)}</span>
        <span class="${l.windowId === 'A' ? 'win-chip win-A' : l.windowId === 'B' ? 'win-chip win-B' : 'win-chip win-other'}">窗口${l.windowId}</span>
        <span class="ver">v${l.version}</span>`;
      const btns = document.createElement('span');
      btns.style.display = 'flex';
      btns.style.gap = '6px';
      if (l.status === 'done') {
        btns.innerHTML = `<span class="badge done">已完成</span>
          <button class="ghost" data-act="undo-prep">撤销完成</button>
          <button class="danger" data-act="remake">重做</button>`;
      } else {
        btns.innerHTML = `<button class="action" data-act="prepare">完成</button>
          <button class="danger" data-act="cancel">取消项</button>`;
      }
      btns.querySelectorAll('button').forEach((b) => {
        b.addEventListener('click', () => act(l, b.dataset.act, o));
      });
      row.appendChild(btns);
      card.appendChild(row);
    }
    card.querySelector('[data-act="pickup"]').addEventListener('click', () =>
      send({ type: 'ConfirmPickup', orderId: o.orderId, by: 'counter' }, `已确认 ${o.pickupNo} 取餐`));
    cardsEl.appendChild(card);
  }
}

function act(line, type, order) {
  const orderId = order.orderId;
  const lineId = line.lineId;
  const expectedVersion = line.version;
  if (type === 'prepare')
    return send({ type: 'PrepareItem', orderId, lineId, expectedVersion, by: `window-${line.windowId}` }, '明细已完成');
  if (type === 'undo-prep')
    return send({ type: 'UndoPrepareItem', orderId, lineId, by: `window-${line.windowId}` }, '已撤销完成');
  if (type === 'remake') {
    const reason = prompt('重做原因（可留空）', '出餐品质问题') ?? null;
    if (reason === null) return;
    return send({ type: 'RemakeItem', orderId, lineId, expectedVersion, by: `window-${line.windowId}`, reason }, '已标记重做，版本已变更');
  }
  if (type === 'cancel') {
    if (!confirm(`取消 ${line.name}？该明细版本将变更，订单按剩余明细重新聚合。`)) return;
    return send({ type: 'CancelItem', orderId, lineId, expectedVersion, reason: '后厨取消' }, '明细已取消');
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

document.getElementById('open-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const no = f.pickupNo.value.trim();
  try {
    const res = await postCommand({ type: 'OpenOrder', pickupNo: no, note: f.note.value.trim() });
    await postCommand({
      type: 'AddItem', orderId: res.appended[0].orderId,
      name: f.name.value.trim(), qty: Number(f.qty.value), windowId: f.windowId.value
    });
    toast(`已开单：取餐号 ${no}`, 'ok');
    f.reset(); f.qty.value = 1; f.windowId.value = 'A';
    api.refresh();
  } catch (err) {
    toast(`开单失败：${err.message}`, 'err');
  }
});

document.getElementById('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  await send({
    type: 'AddItem', orderId: f.orderId.value, name: f.name.value.trim(),
    qty: Number(f.qty.value), windowId: f.windowId.value
  }, '已追加明细');
  f.name.value = ''; f.qty.value = 1;
});

const api = subscribe({
  snapshotUrl: '/api/snapshot',
  onSnapshot: (s) => { snap = s; render(); },
  onStatus: (status) => { dataAgeBadge(status, ageEl); document.body.classList.toggle('offline', !status.online); }
});
