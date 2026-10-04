#!/usr/bin/env bash
# 验收脚本：启动服务 -> 造数 -> 覆盖四个验收点 -> 自动测试套件 -> 关闭
set -e
cd "$(dirname "$0")"
PORT=${PORT:-8099}
export DATA_FILE="$(mktemp -d)/events.jsonl"
PORT=$PORT node server/index.js & SRV=$!
sleep 1
trap 'kill $SRV 2>/dev/null || true' EXIT
B="http://localhost:$PORT"
j() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const f=process.argv[1];eval(f)})' "$1"; }

echo '== 验收1：两窗口同时出餐（部分完成不显示，齐了才显示） =='
OID=$(curl -s -XPOST $B/api/commands -H 'Content-Type: application/json' -d '{"type":"OpenOrder","businessDate":"2026-10-04","pickupNo":"200"}' | j 'console.log(JSON.parse(s).appended[0].orderId)')
LA=$(curl -s -XPOST $B/api/commands -H 'Content-Type: application/json' -d "{\"type\":\"AddItem\",\"orderId\":\"$OID\",\"name\":\"饭\",\"qty\":1,\"windowId\":\"A\"}" | j 'console.log(JSON.parse(s).appended[0].lineId)')
LB=$(curl -s -XPOST $B/api/commands -H 'Content-Type: application/json' -d "{\"type\":\"AddItem\",\"orderId\":\"$OID\",\"name\":\"汤\",\"qty\":1,\"windowId\":\"B\"}" | j 'console.log(JSON.parse(s).appended[0].lineId)')
curl -s -XPOST $B/api/commands -H 'Content-Type: application/json' -d "{\"type\":\"PrepareItem\",\"orderId\":\"$OID\",\"lineId\":\"$LA\",\"expectedVersion\":1}" >/dev/null
test "$(curl -s "$B/api/snapshot?date=2026-10-04" | j 'console.log(JSON.parse(s).ready.length)')" = "0" && echo '  ✓ 单窗口完成未上屏'
curl -s -XPOST $B/api/commands -H 'Content-Type: application/json' -d "{\"type\":\"PrepareItem\",\"orderId\":\"$OID\",\"lineId\":\"$LB\",\"expectedVersion\":1}" >/dev/null
test "$(curl -s "$B/api/snapshot?date=2026-10-04" | j 'console.log(JSON.parse(s).ready.length)')" = "1" && echo '  ✓ 双窗口齐后上屏'

echo '== 验收2：重做通知晚于已取餐（闭环拒绝，状态不变） =='
curl -s -XPOST $B/api/commands -H 'Content-Type: application/json' -d "{\"type\":\"ConfirmPickup\",\"orderId\":\"$OID\"}" >/dev/null
CODE=$(curl -s -o /dev/null -w '%{http_code}' -XPOST $B/api/commands -H 'Content-Type: application/json' -d "{\"type\":\"RemakeItem\",\"orderId\":\"$OID\",\"lineId\":\"$LA\",\"expectedVersion\":2}")
test "$CODE" = "409" && echo '  ✓ 迟到重做被 409 拒绝，订单不复活'

echo '== 验收3：事件缺段后补拉（reset + 整包快照，见 SSE /api/events） =='
curl -s -H 'Last-Event-ID: -999' -N "$B/api/events/stream" --max-time 1 | grep -q 'event: reset' && echo '  ✓ 旧缺口重连返回 reset，客户端整包补拉'

echo '== 验收4：全屏切换背景更换 + 资源不可读兜底 =='
test "$(curl -s "$B/promo.svg" | grep -c '#0f4c81')" = "1"
test "$(curl -s "$B/promo.svg?fullscreen=1" | grep -c '#2b0f54')" = "1" && echo '  ✓ 普通/全屏宣传图配色不同'
test "$(curl -s -o /dev/null -w '%{http_code}' "$B/promo.svg?broken=1")" = "404" && echo '  ✓ 资源可 404；屏幕端监听 error 降级为高对比取餐列表'

echo '== 自动化测试套件 =='
kill $SRV 2>/dev/null || true; wait $SRV 2>/dev/null || true; trap - EXIT
node --test test/
