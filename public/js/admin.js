const ordersEl = document.getElementById('orders');
const eventRows = document.getElementById('event-rows');
const eventCount = document.getElementById('event-count');
const rejRows = document.getElementById('rej-rows');
const ageEl = document.getElementById('age');

function toast(msg, kind = '') {
  const d = document.createElement('div'); d.className = `toast ${kind}`; d.textContent = msg;
  document.getElementById('toasts').appendChild(d);
  setTimeout(() => d.remove(), 4200);
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function statusBadge(o) {
  if (o.pickedUp) return '<span class="badge pickedup">已取餐</span>';
  if (o.cancelled) return '<span class="badge cancelled">已取消</span>';
  const active = o.lines.filter((l) => l.status !== 'cancelled');
  if (active.length && active.every((l) => l.status === 'done')) return '<span class="badge ready">待取餐</span>';
  if (active.some((l) => l.status === 'done')) return '<span class="badge done">部分完成</span>';
  return '<span class="badge prepping">制作中</span>';
}

function renderOrders(snap) {
  ordersEl.innerHTML = '';
  for (const o of snap.orders) {
    const card = document.createElement('div');
    card.className = 'card';
    const lines = o.lines.map((l) => `
      <div class="line-row">
        <span class="lname">${l.qty}× ${esc(l.name)}</span>
        <span class="win-chip ${l.windowId === 'A' ? 'win-A' : l.windowId === 'B' ? 'win-B' : 'win-other'}">窗口${l.windowId}</span>
        <span class="badge ${l.status === 'done' ? 'done' : l.status === 'cancelled' ? 'cancelled' : 'prepping'}">
          ${l.status === 'done' ? '已完成' : l.status === 'cancelled' ? '已取消' : '制作中'}</span>
        <span class="ver">v${l.version}</span>
      </div>`).join('');
    const hist = o.history.map((h) =>
      `<li>[#${h.seq} ${fmtTime(h.ts)}] ${esc(h.label)}${h.by ? ' · ' + esc(h.by) : ''}</li>`).join('');
    card.innerHTML = `
      <h3>取餐号 ${esc(o.pickupNo)} ${statusBadge(o)}
        <span style="font-size:12px;color:var(--muted)">营业日 ${esc(o.businessDate)}</span>
        <span style="flex:1"></span>
        ${o.pickedUp ? '<button class="ghost action" data-undo-pickup>撤销取餐</button>' : ''}
      </h3>
      <div class="order-id">orderId=${esc(o.id)}　开单 ${fmtDateTime(o.createdAt)}</div>
      ${lines}
      <div class="trace">
        <details><summary>状态转换轨迹（${o.history.length} 次）</summary><ul>${hist}</ul></details>
      </div>`;
    const btn = card.querySelector('[data-undo-pickup]');
    if (btn) btn.addEventListener('click', async () => {
      try {
        await postCommand({ type: 'UndoPickup', orderId: o.id, by: 'admin', reason: '后台纠正' });
        toast('已撤销取餐，订单回到待取餐聚合', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    });
    ordersEl.appendChild(card);
  }
}

async function loadEvents() {
  try {
    const data = await getJSON('/api/events');
    eventCount.textContent = `（${data.events.length} 条，lastSeq=${data.lastSeq}）`;
    eventRows.innerHTML = data.events.map((e) => {
      const lv = e.version != null ? `${esc(e.lineId || '')} v${e.version}` : '—';
      return `<tr><td>${e.seq}</td><td>${fmtTime(e.ts)}</td><td><code>${esc(e.type)}</code></td>
        <td>${esc(e.orderId || '')}<br><small style="color:var(--muted)">${esc(e.pickupNo || '')}</small></td>
        <td>${lv}</td><td><code>${esc(JSON.stringify(e)).slice(0, 220)}</code></td></tr>`;
    }).join('');
  } catch (e) { /* 离线时保留旧表 */ }
}

async function loadRejections() {
  try {
    const data = await getJSON('/api/rejections');
    rejRows.innerHTML = data.rejections.map((r) =>
      `<tr><td>${fmtTime(r.ts)}</td><td><code>${esc(r.code)}</code></td><td>${esc(r.message)}</td></tr>`).join('')
      || '<tr><td colspan="3" style="color:var(--muted)">暂无拒绝记录</td></tr>';
  } catch {}
}

document.getElementById('reload-events').addEventListener('click', () => { loadEvents(); loadRejections(); });

subscribe({
  snapshotUrl: '/api/admin/snapshot',
  onSnapshot: (snap, meta) => { renderOrders(snap); if (meta.first || meta.reason === 'gap') { loadEvents(); loadRejections(); } },
  onStatus: (status) => { dataAgeBadge(status, ageEl); document.body.classList.toggle('offline', !status.online); },
  onGap: () => { loadEvents(); }
});
setInterval(loadRejections, 10000);
