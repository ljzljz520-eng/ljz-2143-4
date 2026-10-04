// C 大屏：
//  - 重启恢复相同顺序（readySince 排序来自服务端 seq 投影）
//  - 只在"新进入可取"时播报；指纹 orderId + readyNonce 持久化，不重复播报所有历史号码
//  - 事件缺段由 common.js 整包补拉；数据时效与离线状态显式展示
//  - 全屏切换更换背景宣传图；宣传资源不可读时降级为高对比取餐列表
const listEl = document.getElementById('ready-list');
const ageEl = document.getElementById('age');
const countEl = document.getElementById('ready-count');
const promoImg = document.getElementById('promo-img');
const promoBox = document.getElementById('promo-box');
const screenMain = document.getElementById('screen-main');
const winFilter = document.getElementById('window-filter');
const dateLabel = document.getElementById('date-label');

const ANNOUNCE_KEY = 'pickup.announced.v1';
const announced = new Set(JSON.parse(localStorage.getItem(ANNOUNCE_KEY) || '[]'));
function persistAnnounced() {
  const arr = [...announced].slice(-500);
  localStorage.setItem(ANNOUNCE_KEY, JSON.stringify(arr));
}

let currentSnap = null;
let fullscreen = false;
let soundOn = true;

function winChipClass(w) {
  if (w === 'A') return 'win-chip win-A';
  if (w === 'B') return 'win-chip win-B';
  return 'win-chip win-other';
}

function visibleReady(snap) {
  const f = winFilter.value;
  return snap.ready.filter((r) => !f || r.windows.includes(f));
}

function render() {
  if (!currentSnap) return;
  const rows = visibleReady(currentSnap);
  countEl.textContent = `共 ${rows.length} 单`;
  listEl.innerHTML = '';
  if (!rows.length) {
    listEl.innerHTML = '<div class="empty-hint">暂无待取餐号码<br><small>请留意叫号与窗口提示</small></div>';
    return;
  }
  for (const r of rows) {
    const card = document.createElement('div');
    card.className = 'ready-card';
    card.innerHTML =
      `<div class="no">${r.pickupNo}</div>` +
      `<div class="meta">${r.windows.map((w) => `<span class="${winChipClass(w)}">窗口 ${w} 出餐</span>`).join('')}</div>`;
    listEl.appendChild(card);
  }
}

function speak(no, windows) {
  if (!soundOn || !('speechSynthesis' in window)) return;
  const text = `请 ${no} 号顾客，到 ${windows.join('、')} 窗口取餐`;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-CN';
  u.rate = 0.95;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

// 仅在快照里出现"此前未播报过的 readyNonce"时播报；首次引导/重启不重播历史
function announceNew(prev, snap) {
  const prevMap = new Map((prev ? prev.ready : []).map((r) => [r.orderId, r.readyNonce]));
  for (const r of snap.ready) {
    const fp = `${snap.businessDate}:${r.orderId}#${r.readyNonce}`;
    const wasNonce = prevMap.get(r.orderId);
    const isNewInSession = prev && (wasNonce === undefined || wasNonce !== r.readyNonce);
    if (isNewInSession && !announced.has(fp)) {
      announced.add(fp);
      persistAnnounced();
      speak(r.pickupNo, r.windows);
    }
  }
}

function updateWindowFilter(snap) {
  const cur = winFilter.value;
  winFilter.innerHTML = '<option value="">全部窗口</option>' +
    snap.windows.map((w) => `<option value="${w}"${w === cur ? ' selected' : ''}>窗口 ${w}</option>`).join('');
}

subscribe({
  snapshotUrl: '/api/snapshot',
  onSnapshot: (snap, meta) => {
    dateLabel.textContent = `营业日 ${snap.businessDate}`;
    updateWindowFilter(snap);
    if (meta.first) {
      // 屏幕重启：标记历史号码为已播报，杜绝开机重播全部号码
      for (const r of snap.ready) announced.add(`${snap.businessDate}:${r.orderId}#${r.readyNonce}`);
      persistAnnounced();
    } else {
      announceNew(currentSnap, snap);
    }
    currentSnap = snap;
    render();
  },
  onStatus: (status) => {
    dataAgeBadge(status, ageEl);
    document.body.classList.toggle('offline', !status.online);
  },
  onGap: () => {
    // 缺段已整包补拉：以快照为准，不做本地猜测
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = '检测到事件缺段，已从服务端整包补拉';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }
});

winFilter.addEventListener('change', render);

document.getElementById('sound-toggle').addEventListener('change', (e) => { soundOn = e.target.checked; });
document.getElementById('hc-toggle').addEventListener('change', (e) => {
  document.body.classList.toggle('hc', e.target.checked);
  screenMain.classList.toggle('hc', e.target.checked);
});

// 全屏切换：更换宣传图背景（另一套配色）
function setFullscreen(on) {
  fullscreen = on;
  screenMain.classList.toggle('fullscreen-mode', on);
  promoImg.src = `/promo.svg?fullscreen=${on ? '1' : '0'}`;
  document.getElementById('fs-btn').textContent = on ? '↙ 退出全屏' : '⛶ 全屏';
}
document.getElementById('fs-btn').addEventListener('click', () => {
  if (!document.fullscreenElement) screenMain.requestFullscreen?.().then(() => setFullscreen(true)).catch(() => setFullscreen(true));
  else document.exitFullscreen?.().catch(() => {});
});
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && fullscreen) setFullscreen(false);
});

// 宣传资源不可读：标记 broken，降级为纯高对比列表（列表本身永远可读）
promoImg.addEventListener('error', () => {
  promoBox.classList.add('broken', 'hc');
  document.body.classList.add('hc');
});
// 验收入口：screen.html?broken=1 模拟资源 404
if (new URLSearchParams(location.search).get('broken')) {
  promoImg.src = '/promo.svg?broken=1';
}
