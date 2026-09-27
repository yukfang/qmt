# 银河证券 QMT 策略笔记

在 Cursor 里写脚本，拷到 **Windows VM 里的银河 QMT** 运行。本机 Mac **不能**连 QMT。

## 环境

- 券商：银河证券 QMT 实盘（交易终端-北京）
- 策略 Python：`#coding:gbk`，入口 `init` / `handlebar`
- 不是 MiniQMT，不要用 `xtquant`
- Web：Node（Express），已部署 [qmt.console.enrichlife.today](https://qmt.console.enrichlife.today/)

## 桥接系统（进行中）

目标：QMT 只 HTTP 打 Cloud；Cloud 把 JSON 写入 MySQL；Local / Cloud 都从 MySQL 读。

```text
QMT VM --POST--> Cloud Console --写--> MySQL
Local Console  / Cloud UI      --读--> MySQL
```

| 编号 | 内容 | 状态 |
|---|---|---|
| [1] | QMT 拉挂盘/委托/成交并 POST 到服务器 | 已通 |
| [2] | 服务器下发挂单，QMT 执行 | UI 写 `pending_orders`；`order_exec` 策略轮询执行 |
| [3] | Web UI 展示挂盘/委托/成交 | 已有表格；改读 MySQL |
| [4] | debug 写入 `debug_log` 表 | 进行中 |
| 鉴权 | 网站登录 | 进行中：已加登录页；挂单/策略 API 下一步 |

QMT 不直连数据库。买1/卖1 与挂单队列都经 HTTP。

### MySQL

- `sync_snapshot`：QMT JSON 原样入库（`account+stock` 一行最新快照）
- `debug_log`：追加日志
- `pending_orders`：UI 发起的买挂/卖挂（`pending` → `claimed` → `done`/`failed`）

复制 `.env.example` 为 `.env`，填实例地址。Azure 控制台加同样的环境变量后重新部署。

```bash
cp .env.example .env
npm install
npm start
```

启动时会自动建表。也可手动执行 `server/schema.sql`。

Local 和 Cloud 用**同一套** `QMT_DATABASE_URL`。SSL 使用 `assets/ApsaraDB-CA-Chain/ApsaraDB-CA-Chain.pem`（`?ssl=true`）。

### 看策略日志（给 Cursor 读）

两个 QMT 策略把日志写到 `POST /api/logs`（`source` 为 `status` 或 `exec`，每次启动有一个 `runId`）。异常带完整 traceback；上传失败的行留在内存里，下次补传。

直接读数据库，不需要 token：

```bash
node tools/logs.js                  # 最近 50 行
node tools/logs.js -s exec -n 200   # 执行器
node tools/logs.js -l error --since 60
node tools/logs.js -q claim -f      # 关键字 + 持续跟踪
```

走 HTTP（需要 `X-Bridge-Token` 或网页登录）：`GET /api/logs?tail=100&source=exec&level=error&q=claim&since=60&format=text`

`python3 tools/pull_logs.py` 持续拉 `/api/logs` 写到 `logs/qmt-debug.log`。

### 远程策略（QMT 只放一个加载器）

`strategies/test_rmt_strategy.py` 顶部只改参数：`TOKEN`、`STRATEGY_ID`、`PARAMS`（覆盖远程策略里的全局变量）。挂在行情图上运行（日志出现 `[quote]start simulation mode`）。

服务器按 `strategies/registry.json` 下发：

```json
{ "order_status": { "file": "rmt_order_status.py", "description": "...", "params": {} } }
```

- 新增策略：把 `.py` 放进 `strategies/`，在 registry 里加一项，部署。id 只能用小写字母、数字、下划线
- `params` 是服务器端默认参数，加载器里的 `PARAMS` 优先；`"disabled": true` 停用
- 策略文件里写 `STRATEGY_VERSION = '...'`，下载和日志里会显示版本
- `GET /api/strategies` 列表，`GET /api/strategies/{id}` 下载（需要 `X-Bridge-Token`）

### QMT 侧

每个策略有两份内容相同的文件，只有 `STRATEGY_VERSION` 前缀不同：

| 策略 | 远程版（服务器下发给加载器） | 本地版（直接粘进 QMT 运行） |
|---|---|---|
| 推送委托/成交/买1卖1（只读） | `rmt_order_status.py` | `local_order_status.py` |
| 执行 UI 挂单/撤单 | `rmt_order_exec.py` | `local_order_exec.py` |

1. 平时用加载器 `test_rmt_strategy.py` 跑远程版；加载器或服务器有问题时，把本地版粘进 QMT 直接运行（顶部填 `TOKEN`）
2. 同一个策略不要远程版和本地版同时跑
3. 改策略时两份一起改，版本号一起加
4. 不要回测。推送和执行两个策略可同时跑
4. UI：买1及下方点价格 → 确认买挂；卖1及上方点价格 → 确认卖挂；默认数量 10000，滑条左右各 5 格（1000），拉到端点后窗口平移

## 已确认能用

| 事项 | 结论 |
|---|---|
| 代码写法 | 深市 ETF：`159781.SZ` |
| 最新快照 | `ContextInfo.get_full_tick`，Level-1；`bidPrice[0]`/`askPrice[0]` 为买1/卖1 |
| 外网 POST | VM 能访问公网 HTTP 并读 response |
| 账户委托/成交 | 必须实盘。`get_trade_detail_data(account, 'stock', 'order'\|'deal')` |

## 仓库文件

- `strategies/tick_push_once.py`：tick 快照 POST httpcan（已验证）
- `strategies/account_orders_deals.py`：实盘打印挂盘/成交明细（已验证）
- `strategies/rmt_order_status.py` / `local_order_status.py`：持续推 sync + 日志到 Web
- `strategies/rmt_order_exec.py` / `local_order_exec.py`：拉取 pending 挂单/撤单并实盘执行
- `strategies/test_rmt_strategy.py`：远程策略加载器；`strategies/registry.json`：下发清单
- `server/`：Express；写入/读取 MySQL
- `server/schema.sql`：表结构
- `tools/logs.js`：直接查 `debug_log` 看策略日志
- `tools/pull_logs.py`：每秒拉 `/api/logs` 到本地

## API

- `POST /api/sync` 挂盘/委托/成交
- `GET /api/state?since=VERSION` UI 用。无内容更新返回 `{unchanged:true, version, updatedAt, pendingHangs}`；`updatedAt` 为 epoch 毫秒（每次 QMT sync 都会刷新），前端按本机时区显示。`pendingHangs` 为尚未完成的 UI 挂单请求
- `POST /api/hang` UI 发起买挂/卖挂（校验：买挂 ≤ 买1，卖挂 ≥ 卖1）
- `POST /api/cancel` UI 对券商挂单发起撤单请求（`action=cancel`，写入同一张 `pending_orders`）
- `GET /api/commands` QMT 拉 `pending` 队列
- `POST /api/commands/:id/claim` 认领
- `POST /api/commands/:id/result` 回报成功/失败
- `POST /api/debug` QMT 日志
- `GET /api/debug?after=ID` 本机拉日志
- `GET /api/health` 含 `appVersion`（来自 `package.json`）
- `POST /api/login` `{ username, password }`，成功后写 HttpOnly Cookie
- `POST /api/logout`
- `GET /api/session` 未登录返回 401

网站登录：环境变量 `CONSOLE_PASSWORD` 非空才启用（用户名默认 `CONSOLE_USER=admin`）。可选 `SESSION_SECRET`。未配密码时控制台仍公开。控制台拉状态/挂撤认登录 Cookie；策略同步与认领仍用可选 `X-Bridge-Token`（`BRIDGE_TOKEN`）。

## 注意

- 试验策略不要下单。
- 行情/成交只自用，不要转发。
- Azure publish profile 拿到后再部署；不要把 profile 提交进 git。
