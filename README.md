# 银河证券 QMT 策略笔记

在 Cursor 里写脚本，拷到 **Windows VM 里的银河 QMT** 运行。本机 Mac **不能**连 QMT。

## 环境

- 券商：银河证券 QMT 实盘（交易终端-北京）
- 策略 Python：`#coding:gbk`，入口 `init` / `handlebar`
- 不是 MiniQMT，不要用 `xtquant`
- Web：Node（Express），已部署 [ptrade.console.enrichlife.today](https://ptrade.console.enrichlife.today/)

## 桥接系统（进行中）

目标：QMT 只 HTTP 打 Cloud；Cloud 把 JSON 写入 MySQL；Local / Cloud 都从 MySQL 读。

```text
QMT VM --POST--> Cloud Console --写--> MySQL
Local Console  / Cloud UI      --读--> MySQL
```

| 编号 | 内容 | 状态 |
|---|---|---|
| [1] | QMT 拉挂盘/委托/成交并 POST 到服务器 | 已通 |
| [2] | 服务器下发挂单，QMT 执行 | UI 写 `pending_orders`；`qmt_hang_executor.py` 轮询执行 |
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

Local 和 Cloud 用**同一套** `PTRADE_DATABASE_URL`。SSL 使用 `assets/ApsaraDB-CA-Chain/ApsaraDB-CA-Chain.pem`（`?ssl=true`）。

### 拉 debug 日志（给 Cursor 读）

```bash
python3 tools/pull_logs.py
```

默认拉线上 `https://ptrade.console.enrichlife.today`，写入 `logs/qmt-debug.log`。

### QMT 侧

1. `qmt_bridge.py`：实盘启动，推委托/成交/买1卖1（只读）
2. `qmt_hang_executor.py`：另开一条实盘策略，轮询 `/api/commands` 并 `passorder` 限价挂单
3. 不要回测。两个策略可同时跑
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
- `strategies/qmt_bridge.py`：持续推 sync + debug 到 Web
- `strategies/qmt_hang_executor.py`：拉取 pending 挂单并实盘 `passorder`
- `server/`：Express；写入/读取 MySQL
- `server/schema.sql`：表结构
- `tools/pull_logs.py`：每秒拉 `/api/debug` 到本地（可选，库通了之后可直接查 `debug_log`）

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
