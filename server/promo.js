// 宣传图由服务端生成（SVG）。?broken=1 时返回 404，用于验收"资源不可读仍有高对比取餐列表"。
const BG = {
  normal: ['#0f4c81', '#1b8f72'],
  full: ['#2b0f54', '#8a1f6b']
};

export function promoSvg(fullscreen = false) {
  const [c1, c2] = fullscreen ? BG.full : BG.normal;
  const title = fullscreen ? '美味现做 · 凭号取餐' : '欢迎光临';
  const sub = fullscreen ? '请留意取餐号码，过号请联系前台' : '今日特餐 · 新鲜出炉';
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/>
    </linearGradient>
  </defs>
  <rect width="960" height="540" fill="url(#g)"/>
  <circle cx="820" cy="110" r="160" fill="#ffffff" opacity="0.08"/>
  <circle cx="120" cy="460" r="120" fill="#ffffff" opacity="0.08"/>
  <text x="480" y="250" text-anchor="middle" font-family="'PingFang SC','Microsoft YaHei',sans-serif"
        font-size="64" font-weight="700" fill="#ffffff">${title}</text>
  <text x="480" y="330" text-anchor="middle" font-family="'PingFang SC','Microsoft YaHei',sans-serif"
        font-size="30" fill="#eaf6ff">${sub}</text>
  <text x="480" y="430" text-anchor="middle" font-family="'PingFang SC','Microsoft YaHei',sans-serif"
        font-size="24" fill="#ffd964">🍜 现炒现做　🍵 安心食材　🥡 叫号取餐</text>
</svg>`;
}
