# 餐厅取餐提醒全栈系统（事件投影 / Event Sourcing + SSE）

三个角色：

| 入口 | 使用者 | 作用 |
| --- | --- | --- |
| `/screen.html` | C 窗口大屏 | 宣传图 + 待取号码、语音叫号、断网时效、全屏/高对比 |
| `/kitchen.html` | 后厨 Web 端 | 按窗口报告完成、追加菜、取消项、重做、确认取餐 |
| `/admin.html` | 后台 | 每次状态转换追溯、原始事件流、被拒操作审计 |

零第三方依赖，Node ≥ 18。

```bash
npm start                 # 启动 :8080（PORT / DATA_FILE / BUSINESS_TZ 可覆盖）
node demo-seed.js         # 启动后灌入演示数据
./acceptance.sh           # 一键验收（四个验收点 + 15 项自动化测试）
npm test                  # 仅跑自动化测试
```

## 为什么选事件投影（不选订单汇总事务）

状态由**明细行的生命周期**决定（同一单可拆两窗口、追加、取消单项、单项重做），
"订单状态"不是单一聚合上的一个可覆盖字段。事件投影把每次变化固化为不可变事件，
读模型由事件折叠得到，天然满足题目要求：

- 追加菜 / 取消项 / 重做都落在**具体明细行的新版本**（`lineId + version`），
  不会出现"按最后一条消息设置整单状态"；
- 部分完成不可取：可取 = `未取消明细全部 done` 的跨窗口聚合结果；
- 任何时刻都可从 `data/events.jsonl` 重放出相同状态与顺序（`seq` 全序）；
- 管理页能展示每次状态转换（订单内 `history`，按 seq 排序）。

事件类型：`OrderOpened / ItemAdded / ItemPrepared / ItemPreparationUndone /
ItemRemade / ItemCancelled / OrderPickedUp / OrderPickupUndone / OrderCancelled`。

## 并发完成与撤销规则

1. **单写者锁**（`store.withLock`）：所有命令的"读聚合 → 校验 → 追加事件 → 更新投影"在临界区内串行，锁内无 await/IO 竞争。
2. **乐观并发（明细版本）**：`PrepareItem / CancelItem / RemakeItem` 必须带 `expectedVersion`。
   版本不符返回 `409 VERSION_CONFLICT`，响应携带服务端当前版本，客户端整包刷新后重试——**服务端投影是唯一事实**。
3. **完成幂等**：两个"完成"同时到，第一个追加 `ItemPrepared`，第二个看到已 `done` 直接 no-op（不报错、不重复出事件）；HTTP 层另有 `Idempotency-Key` 防网络重试。
4. **撤销完成**：`UndoPrepareItem` 不升版本、把行打回 `prepping`（旧的迟到完成因已非 done 且版本过期而冲突）；**重做** `RemakeItem` 保留同一 `lineId` 但版本 +1。
5. **取餐闭环**：已取餐订单拒绝一切明细修改（`409 ORDER_CLOSED`）——"重做通知晚于已取餐"被忽略，订单不复活；必须先 `UndoPickup`（后台纠误）才能改。
6. 被拒绝的操作进入环形审计日志 `/api/rejections`，可回答"为什么没动"。

## 稳定身份与取餐号复用

- 更新一律携带服务端签发的 `orderId`（`ord_…`）与 `lineId`（`li_…`）；取餐号仅用于展示与叫号。
- 取餐号唯一性按 `(businessDate, pickupNo)` 约束，**跨营业日可复用**（UTC+8 划分营业日，可用 `BUSINESS_TZ` 覆盖）。

## 实时性、缺段补拉与断网

- 写操作经 SSE 广播 `mutation(seq)`；客户端收到连续 seq 后合并刷新快照，发现缺口（gap）立即**整包补拉**，不按单条事件猜测状态。
- 重连自动带 `Last-Event-ID`：服务端环形缓冲（最近 500 条）能补则补；缺口太旧返回 `event: reset`，客户端整包重拉。
- 心跳 15s + `navigator.onLine` 推导数据年龄：`实时 / N 秒未更新 / 离线`。
- **离线时所有写按钮禁用并显示红条**："缓存画面非中心确认"，杜绝把缓存按钮当中心确认。

## C 屏专项

- 重启后顺序与服务端 `readySince`（进入可取时的 seq）一致；
- 语音只播"新进入可取"的号码，指纹为 `orderId#readyNonce` 并持久化到 localStorage：
  开机/刷新把现存号码标记为已播报，**不重播全部历史**；重做后重新出齐会换新 nonce 再播一次；
- 全屏切换请求 `/promo.svg?fullscreen=1`（另一套配色背景）；
- 宣传图 404（或 `/screen.html?broken=1` 演示）时隐藏图片、切换黑黄高对比样式，**取餐列表始终可读**；另有手动高对比开关与窗口筛选。

## 目录

```
server/  store.js(事件存储) projection.js(折叠/读模型) commands.js(命令与不变量)
         sse.js(推送/补段) index.js(HTTP) promo.js clock.js
public/  screen*.html/js  kitchen*.html/js  admin*.html/js  js/common.js css/style.css
test/    domain.test.js server.test.js
data/    events.jsonl（事实源，重启重放）
```
