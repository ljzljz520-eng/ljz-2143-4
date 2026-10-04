// 营业日：固定 UTC+8 划分；可用环境变量覆盖。取餐号只在同一营业日内唯一，跨日可复用。
export function businessDateFor(d = new Date(), tz = process.env.BUSINESS_TZ || 'Asia/Shanghai') {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d); // YYYY-MM-DD
  } catch {
    return d.toISOString().slice(0, 10);
  }
}
