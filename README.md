# 餐厅取餐提醒全栈系统

一个零运行时依赖的事件溯源（Event Sourcing + Projection）示例：Node.js 内置 HTTP 服务持久化 JSONL 事件，后厨 Web 端逐明细报菜，C 窗口顾客屏实时显示宣传图和待取号码，管理页追踪每次订单/明细状态转换。

## 启动

```bash
npm install   # 本项目没有第三方依赖，仅生成/校验 lock 时可省略
npm run seed  # 可选：写入跨日复用取餐号、双窗口部分完成示例
npm start
```

默认地址：<http://localhost:3000>

- 顾客屏（C 窗口）：`/screen.html`
- 后厨 Web 端：`/kitchen.html`
- 管理/审计：`/admin.html`

环境变量：`PORT`、`HOST`、`EVENT_FILE`。

## 架构选择：事件投影，而不是订单汇总事务覆盖

系统选择 **仅追加事件日志 + 内存/重启投影**：

1. 所有命令进入中心同一临界区，校验后追加一条不可变事件。
2. 投影按 `globalVersion` 顺序重放事件，计算每个明细版本、整单状态、每日可取顺序。
3. 顾客屏只读取投影结果，不从最后一条消息推断订单状态。
4. JSONL 缺行、坏行、版本跳跃会拒绝继续加载，避免产生双投影。

这比“更新一行订单汇总状态”更适合追菜、取消、重做、迟到撤销和审计。关系型数据库实现可把事件表作为事实表，投影表作为物化视图，在同一数据库事务中完成 append + projection update，或用 outbox/CDC 异步投影。

## 事件与明细版本

事件类型：

- `order-created`
- `item-added`
- `item-completed`
- `item-unready`
- `item-canceled`
- `item-remade`
- `pickup-confirmed`

明细字段 `version` 表示具体明细版本：

| 操作 | 明细版本变化 |
| --- | --- |
| 创建/追加 | 新明细从 v1 开始 |
| 完成 | vN → vN+1，记录 `readyVersion` |
| 撤销完成 | vN → vN+1，回到制作中 |
| 重做 | vN → vN+1，回到制作中，`remakeCount+1` |
| 取消 | vN → vN+1，后续从活动明细中排除 |

按钮请求必须携带：

- 稳定 `orderId`；
- `date`（营业日）；
- 具体 `itemId`；
- 操作前看到的 `expectedVersion`；
- 可选 `idempotencyKey`、`by`、`reason`。

取餐号 `pickupNo` 只用于同一营业日内的人类识别，不作为更新主键。不同营业日可以复用同一取餐号；日期与订单不匹配返回 `DATE_MISMATCH`。

## 整单状态规则

投影状态：

- `preparing`：至少一个未取消明细未完成；
- `ready`：所有未取消明细均完成；
- `picked`：中心确认取餐；
- `empty`：明细全部取消。

一单可拆 A/B 两窗口。只完成 A 窗口时，即使事件显示某菜已可取，整单仍为 `preparing`，顾客屏不显示号码。

当订单从 `preparing → ready` 时分配该营业日的 `readySequence`。撤销、重做或追加菜导致不再全齐，会清除旧的可取顺序；再次全齐时分配新的顺序号。因此屏幕重启仍能按相同顺序恢复，且历史号码不会被当作“新转换”重新播报。

## 并发完成与撤销规则

1. 中心单进程用 FIFO 临界区串行化写命令；生产实现应使用数据库事务、事件表唯一序号或流分区。
2. 明细采用乐观并发：事件重放要求当前明细版本等于 `expectedVersion`。
3. 两个完成请求并发：只有一个能成功，另一个若基于旧版本得到 `ITEM_VERSION_CONFLICT`，客户端刷新，不做静默重复。
4. 完成和撤销并发：先提交者生效；后提交者若携带旧版本被拒绝。操作员刷新并看到新版本后，才能明确撤销。
5. 重做要求明细当前已完成；重做立即撤销该具体成品版本。整单未取时它让整单回到制作中；再次全齐得到新顺序号。
6. 已取餐后迟到的重做/撤销返回 `ORDER_LOCKED`，不得修改顾客已确认订单。更正需新开订单或另建补偿事件（本示例未开放）。
7. 相同 `idempotencyKey` 的同一命令返回原事件；同键不同载荷返回 `IDEMPOTENCY_KEY_REUSED`。

## 断网与缓存安全

- 顾客屏没有任何取餐确认按钮，确认只能由后厨/中心端调用中心 API。
- SSE 断连时，页面显示“断网/连接中断”、事件版本和最近事件时间；列表明确标注为本机缓存，不是中心确认。
- 后厨端断网时禁用所有操作按钮，恢复后先拉 `/api/state` 全量校准。
- 不使用 Service Worker 缓存 POST，也不把本地按钮状态当作中心事实。

## 事件缺段与补拉

SSE 事件携带连续 `globalVersion`。客户端实时收到非 `version+1` 事件时不猜状态，而是请求：

```http
GET /api/state?date=YYYY-MM-DD
```

用当天完整快照替换投影，并静默处理补拉结果，避免旧号码补播。重连时 `/api/stream?after=N&date=...` 也会先补事件，再发送快照；管理页提供按版本拉取和缺段检测按钮。

## 全屏、播报和可读性

- 进入/退出全屏会切换 `screen-fullscreen` 背景与宣传图：`promo.svg` ↔ `promo-night.svg`。
- 浏览器拒绝全屏时仍有样式回退；图片读取失败时显示高对比 CSS/SVG 文案区。
- 顾客屏首次加载和重启只显示历史号码，不逐条朗读；仅实时的 `preparing → ready` 转换触发一次语音和高亮。
- CSS 包含 `prefers-contrast: more`，即使宣传图不可读，号码列表仍为深色背景、大号高对比文字。

## HTTP API

### 命令

```http
POST /api/commands
Content-Type: application/json
```

示例：双窗口创建、完成 A/B：

```json
{"type":"create-order","date":"2026-10-05","pickupNo":"101","items":[
  {"id":"i-a","name":"牛肉堡","qty":1,"window":"A"},
  {"id":"i-b","name":"柠檬茶","qty":1,"window":"B"}
]}
```

```json
{"type":"complete-item","date":"2026-10-05","orderId":"<uuid>","itemId":"i-a","expectedVersion":1}
```

其他命令：`add-item`、`undo-item`、`cancel-item`、`remake-item`、`confirm-pickup`。

### 查询

- `GET /api/state?date=YYYY-MM-DD`：当天订单投影和 ready 列表。
- `GET /api/orders/:orderId`：稳定订单详情与明细历史。
- `GET /api/events?after=N&date=...&orderId=...`：事件段。
- `GET /api/transitions?date=...&orderId=...`：订单状态转换流水。
- `GET /api/stream?date=...&after=N`：SSE，事件、快照、心跳。
- `GET /api/health`：健康检查。

## 验收脚本

```bash
npm test
```

覆盖：

1. A/B 两窗口同时出餐，单窗口完成不上屏；
2. 重做通知晚于已取餐时被中心拒绝；
3. 事件版本恢复、缺段检测与全量快照补拉接口；
4. 追加菜、取消、撤销、重做均修改具体明细版本；
5. 并发完成/撤销的旧版本冲突规则；
6. 跨营业日复用取餐号且必须携带稳定订单身份；
7. 屏幕静态页无确认按钮、含断网时效提示和高对比 CSS。
