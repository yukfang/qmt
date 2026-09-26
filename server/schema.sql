-- 第一版表；应用启动时也会 CREATE IF NOT EXISTS。
-- payload 存 QMT 推过来的完整 JSON，字段稳定后再拆列。

CREATE TABLE IF NOT EXISTS sync_snapshot (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  account VARCHAR(64) NOT NULL DEFAULT '',
  stock VARCHAR(32) NOT NULL DEFAULT '',
  payload JSON NOT NULL,
  content_hash VARCHAR(40) NOT NULL DEFAULT '',
  version BIGINT NOT NULL DEFAULT 0,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_account_stock (account, stock)
);

CREATE TABLE IF NOT EXISTS debug_log (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  ts VARCHAR(40) NOT NULL,
  level VARCHAR(16) NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_id (id)
);

-- UI 发起的买挂/卖挂，QMT 执行策略轮询后下单
CREATE TABLE IF NOT EXISTS pending_orders (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  account VARCHAR(64) NOT NULL DEFAULT '',
  stock VARCHAR(32) NOT NULL,
  side VARCHAR(8) NOT NULL,
  price DECIMAL(16,6) NOT NULL,
  qty INT NOT NULL DEFAULT 10000,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  source VARCHAR(32) NOT NULL DEFAULT 'ui',
  error_message VARCHAR(512) NULL,
  broker_order_id VARCHAR(64) NULL,
  action VARCHAR(16) NOT NULL DEFAULT 'hang',
  target_order_id VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  claimed_at DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
-- 巡航状态按登录用户 + live/sim 通道保存，本地和 Cloud 共用
CREATE TABLE IF NOT EXISTS user_cruise (
  username VARCHAR(64) NOT NULL,
  channel VARCHAR(8) NOT NULL,
  cruise_on TINYINT NOT NULL DEFAULT 0,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (username, channel)
);

CREATE TABLE IF NOT EXISTS cruise_seen (
  username VARCHAR(64) NOT NULL,
  channel VARCHAR(8) NOT NULL,
  kind VARCHAR(8) NOT NULL,
  item_key VARCHAR(190) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (username, channel, kind, item_key)
);
