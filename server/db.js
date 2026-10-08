const fs = require("fs");
const { pickLastDeal } = require("./deals");
const path = require("path");
const mysql = require("mysql2/promise");

let pool;

const DEFAULT_CA = path.join(__dirname, "..", "assets", "ApsaraDB-CA-Chain", "ApsaraDB-CA-Chain.pem");

function stripQuotes(value) {
  const s = String(value || "").trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseMysqlUrl(raw) {
  const s = stripQuotes(raw);
  if (!s.startsWith("mysql://")) {
    throw new Error("QMT_DATABASE_URL must start with mysql://");
  }
  const rest = s.slice("mysql://".length);
  const at = rest.lastIndexOf("@");
  if (at < 0) {
    throw new Error("QMT_DATABASE_URL missing host");
  }
  const userinfo = rest.slice(0, at);
  const hostpart = rest.slice(at + 1);
  const colon = userinfo.indexOf(":");
  const user = decodeURIComponent(colon >= 0 ? userinfo.slice(0, colon) : userinfo);
  const password = decodeURIComponent(colon >= 0 ? userinfo.slice(colon + 1) : "");
  const [hostportpath, query] = hostpart.split("?");
  const slash = hostportpath.indexOf("/");
  const hostport = slash >= 0 ? hostportpath.slice(0, slash) : hostportpath;
  const database = decodeURIComponent(slash >= 0 ? hostportpath.slice(slash + 1) : "");
  const [host, port] = hostport.split(":");
  const params = new URLSearchParams(query || "");
  return {
    host,
    port: Number(port || 3306),
    user,
    password,
    database,
    ssl: String(params.get("ssl") || "").toLowerCase(),
  };
}

function sslOption(urlSsl) {
  const flag = String(urlSsl || process.env.MYSQL_SSL || "true").toLowerCase();
  if (flag === "0" || flag === "false" || flag === "disable") {
    return undefined;
  }
  const caPath = path.isAbsolute(process.env.MYSQL_SSL_CA || "")
    ? process.env.MYSQL_SSL_CA
    : process.env.MYSQL_SSL_CA
      ? path.join(__dirname, "..", process.env.MYSQL_SSL_CA)
      : DEFAULT_CA;
  if (!fs.existsSync(caPath)) {
    throw new Error("MySQL SSL CA not found: " + caPath);
  }
  return {
    ca: fs.readFileSync(caPath),
    rejectUnauthorized: process.env.MYSQL_SSL_REJECT_UNAUTHORIZED !== "false",
    minVersion: "TLSv1.2",
  };
}

function connectionConfig() {
  const databaseUrl = process.env.QMT_DATABASE_URL || process.env.PTRADE_DATABASE_URL;
  if (databaseUrl) {
    const parsed = parseMysqlUrl(databaseUrl);
    if (!parsed.host || !parsed.user || !parsed.database) {
      throw new Error("QMT_DATABASE_URL/PTRADE_DATABASE_URL is incomplete");
    }
    return {
      host: parsed.host,
      port: parsed.port,
      user: parsed.user,
      password: parsed.password,
      database: parsed.database,
      ssl: sslOption(parsed.ssl),
    };
  }
  const host = process.env.MYSQL_HOST;
  const user = process.env.MYSQL_USER;
  const database = process.env.MYSQL_DATABASE;
  if (!host || !user || !database) {
    throw new Error("Set QMT_DATABASE_URL/PTRADE_DATABASE_URL or MYSQL_HOST/MYSQL_USER/MYSQL_DATABASE");
  }
  return {
    host,
    port: Number(process.env.MYSQL_PORT || 3306),
    user,
    password: process.env.MYSQL_PASSWORD || "",
    database,
    ssl: sslOption(),
  };
}

function getPool() {
  if (pool) {
    return pool;
  }
  const cfg = connectionConfig();
  pool = mysql.createPool({
    ...cfg,
    waitForConnections: true,
    connectionLimit: 10,
    timezone: "Z",
  });
  return pool;
}

async function ensureSchema() {
  const db = getPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS sync_snapshot (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      account VARCHAR(64) NOT NULL DEFAULT '',
      stock VARCHAR(32) NOT NULL DEFAULT '',
      payload JSON NOT NULL,
      content_hash VARCHAR(40) NOT NULL DEFAULT '',
      version BIGINT NOT NULL DEFAULT 0,
      updated_at DATETIME(3) NOT NULL,
      UNIQUE KEY uk_account_stock (account, stock)
    )
  `);
  await ensureColumn("sync_snapshot", "content_hash", "VARCHAR(40) NOT NULL DEFAULT ''");
  await ensureColumn("sync_snapshot", "version", "BIGINT NOT NULL DEFAULT 0");
  await ensureIndex("sync_snapshot", "idx_sync_stock", "stock");
  await backfillSnapshotVersions();
  await db.query(`
    CREATE TABLE IF NOT EXISTS debug_log (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      ts VARCHAR(40) NOT NULL,
      level VARCHAR(16) NOT NULL DEFAULT 'info',
      message TEXT NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY idx_id (id)
    )
  `);
  await ensureColumn("debug_log", "source", "VARCHAR(32) NOT NULL DEFAULT ''");
  await ensureColumn("debug_log", "run_id", "VARCHAR(32) NOT NULL DEFAULT ''");
  await ensureColumn("debug_log", "auth", "VARCHAR(16) NOT NULL DEFAULT ''");
  await ensureIndex("debug_log", "idx_debug_source", "source, id");
  await db.query(`
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
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      claimed_at DATETIME(3) NULL,
      finished_at DATETIME(3) NULL,
      KEY idx_status_id (status, id)
    )
  `);
  await ensureColumn("pending_orders", "action", "VARCHAR(16) NOT NULL DEFAULT 'hang'");
  await ensureColumn("pending_orders", "target_order_id", "VARCHAR(64) NULL");
  await ensureIndex("pending_orders", "idx_pending_stock_status", "stock, status");
  await db.query(`
    CREATE TABLE IF NOT EXISTS user_cruise (
      username VARCHAR(64) NOT NULL,
      channel VARCHAR(8) NOT NULL,
      cruise_on TINYINT NOT NULL DEFAULT 0,
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (username, channel)
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS cruise_seen (
      username VARCHAR(64) NOT NULL,
      channel VARCHAR(8) NOT NULL,
      kind VARCHAR(8) NOT NULL,
      item_key VARCHAR(190) NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (username, channel, kind, item_key)
    )
  `);
  await ensureColumn("user_cruise", "rungs_json", "TEXT NULL");
  await ensureColumn("user_cruise", "lease_holder", "VARCHAR(64) NULL");
  await ensureColumn("user_cruise", "lease_until", "DATETIME(3) NULL");
  await ensureColumn("user_cruise", "hang_qty", "INT NULL");
  await ensureColumn("user_cruise", "grid_step", "DECIMAL(8,3) NULL");
  await ensureColumn("user_cruise", "reverse_gap", "DECIMAL(8,3) NULL");
  await ensureColumn("user_cruise", "min_spread", "DECIMAL(8,3) NULL");
  await ensureCruiseChannelWidth();
  await db.query(`
    CREATE TABLE IF NOT EXISTS stock_last_deal (
      stock VARCHAR(16) NOT NULL PRIMARY KEY,
      side VARCHAR(4) NOT NULL,
      price DECIMAL(12,3) NOT NULL,
      qty INT NOT NULL,
      trade_date CHAR(8) NOT NULL,
      trade_time CHAR(6) NOT NULL DEFAULT '',
      trade_id VARCHAR(64) NOT NULL DEFAULT '',
      order_id VARCHAR(64) NOT NULL DEFAULT '',
      rank_no BIGINT NOT NULL,
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
    )
  `);
}

// QMT only reports today's deals, so the latest deal is kept here; after a quiet day the row
// still holds the previous trading day's last deal. Only a later-ranked deal overwrites it.
function shanghaiDateDigits(ms) {
  const when = Number.isFinite(Number(ms)) && Number(ms) > 0 ? new Date(Number(ms)) : new Date();
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(when).replace(/\D/g, "");
}

async function rememberLastDeal(stock, deals, assumedDate) {
  const last = pickLastDeal(deals, assumedDate);
  if (!last) return;
  const db = getPool();
  await db.query(
    `INSERT INTO stock_last_deal (stock, side, price, qty, trade_date, trade_time, trade_id, order_id, rank_no)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       side = IF(VALUES(rank_no) > rank_no, VALUES(side), side),
       price = IF(VALUES(rank_no) > rank_no, VALUES(price), price),
       qty = IF(VALUES(rank_no) > rank_no, VALUES(qty), qty),
       trade_date = IF(VALUES(rank_no) > rank_no, VALUES(trade_date), trade_date),
       trade_time = IF(VALUES(rank_no) > rank_no, VALUES(trade_time), trade_time),
       trade_id = IF(VALUES(rank_no) > rank_no, VALUES(trade_id), trade_id),
       order_id = IF(VALUES(rank_no) > rank_no, VALUES(order_id), order_id),
       rank_no = GREATEST(rank_no, VALUES(rank_no))`,
    [stock, last.side, last.price, last.qty, last.date, last.time, last.tradeId.slice(0, 64), last.orderId.slice(0, 64), last.rank]
  );
}

async function getLastDeal(stock) {
  const db = getPool();
  const [rows] = await db.query(
    `SELECT side, price, qty, trade_date, trade_time, trade_id, order_id, rank_no FROM stock_last_deal WHERE stock = ?`,
    [normalizeStockCode(stock)]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    side: row.side,
    price: Number(row.price),
    qty: Number(row.qty),
    date: String(row.trade_date),
    time: String(row.trade_time || ""),
    tradeId: String(row.trade_id || ""),
    orderId: String(row.order_id || ""),
    rank: Number(row.rank_no) || 0,
  };
}

async function ensureColumn(table, column, def) {
  const db = getPool();
  const [rows] = await db.query(`SHOW COLUMNS FROM \`${table}\` LIKE ?`, [column]);
  if (!rows.length) {
    await db.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${def}`);
  }
}

async function ensureIndex(table, name, columns) {
  const db = getPool();
  const [rows] = await db.query(`SHOW INDEX FROM \`${table}\` WHERE Key_name = ?`, [name]);
  if (!rows.length) {
    await db.query(`ALTER TABLE \`${table}\` ADD INDEX \`${name}\` (${columns})`);
  }
}

async function ensureCruiseChannelWidth() {
  const db = getPool();
  for (const table of ["user_cruise", "cruise_seen"]) {
    const [rows] = await db.query(`SHOW COLUMNS FROM \`${table}\` LIKE 'channel'`);
    const type = String((rows[0] && rows[0].Type) || "");
    const match = type.match(/varchar\((\d+)\)/i);
    const width = match ? Number(match[1]) : 0;
    if (width && width < 48) {
      await db.query(`ALTER TABLE \`${table}\` MODIFY channel VARCHAR(48) NOT NULL`);
    }
  }
}

function hashPayload(json) {
  const crypto = require("crypto");
  return crypto.createHash("sha1").update(json).digest("hex");
}

async function backfillSnapshotVersions() {
  const db = getPool();
  const [rows] = await db.query(
    `SELECT id, payload, version, content_hash
     FROM sync_snapshot
     WHERE version = 0 OR content_hash = '' OR content_hash IS NULL`
  );
  for (const row of rows) {
    const json = typeof row.payload === "string" ? row.payload : JSON.stringify(row.payload);
    const hash = row.content_hash || hashPayload(json);
    await db.query(
      `UPDATE sync_snapshot
       SET version = GREATEST(COALESCE(version, 0), 1), content_hash = ?
       WHERE id = ?`,
      [hash, row.id]
    );
  }
}

async function saveSnapshot(payload) {
  const account = String(payload.account || "");
  const stock = normalizeStockCode(payload.stock || "");
  if (!stock) {
    const err = new Error("stock required for sync");
    err.status = 400;
    throw err;
  }
  payload.stock = stock;
  const json = JSON.stringify(payload);
  const hash = hashPayload(json);
  const db = getPool();
  const [cur] = await db.query(
    `SELECT version, content_hash FROM sync_snapshot WHERE account = ? AND stock = ?`,
    [account, stock]
  );
  const prev = cur[0];
  const prevVersion = prev ? Number(prev.version) || 0 : 0;
  const same = Boolean(prev && prev.content_hash && prev.content_hash === hash && prevVersion > 0);
  const nextVersion = same ? prevVersion : Math.max(1, prevVersion + 1);

  await db.query(
    `INSERT INTO sync_snapshot (account, stock, payload, content_hash, version, updated_at)
     VALUES (?, ?, CAST(? AS JSON), ?, ?, CURRENT_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE
       payload = IF(content_hash = VALUES(content_hash), payload, VALUES(payload)),
       version = VALUES(version),
       updated_at = CURRENT_TIMESTAMP(3),
       content_hash = VALUES(content_hash)`,
    [account, stock, json, hash, nextVersion]
  );
  if (String(payload.source || "") !== "sim" && account !== "SIM") {
    await rememberLastDeal(stock, payload.deals).catch((err) => console.error("rememberLastDeal failed:", err.message));
  }
  const [rows] = await db.query(
    `SELECT updated_at, UNIX_TIMESTAMP(updated_at) AS updated_at_unix, version
     FROM sync_snapshot WHERE account = ? AND stock = ?`,
    [account, stock]
  );
  return {
    updatedAt: rows[0] ? toEpochMs(rows[0].updated_at_unix, rows[0].updated_at) : Date.now(),
    version: rows[0] ? Number(rows[0].version) || nextVersion : nextVersion,
    unchanged: Boolean(same),
    stock,
  };
}

function toEpochMs(unixSeconds, fallback) {
  const n = Number(unixSeconds);
  if (Number.isFinite(n) && n > 0) {
    return Math.round(n * 1000);
  }
  if (fallback instanceof Date) {
    const t = fallback.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (fallback == null) return null;
  const d = fallback instanceof Date ? fallback : new Date(fallback);
  const t = d.getTime();
  return Number.isNaN(t) ? null : t;
}

function parsePayload(value) {
  if (value == null) {
    return null;
  }
  if (typeof value === "object") {
    return value;
  }
  return JSON.parse(value);
}

function emptySnapshot() {
  return {
    unchanged: false,
    version: 0,
    updatedAt: null,
    account: "",
    stock: "",
    openOrders: [],
    orders: [],
    deals: [],
    pendingHangs: [],
    pendingCancels: [],
  };
}

function stockCodeVariants(stock) {
  const code = normalizeStockCode(stock);
  const short = code.replace(/\.SZ$/i, "").replace(/\.SH$/i, "");
  return { code, short };
}

function snapshotStockWhere(column, stock, params) {
  const { code, short } = stockCodeVariants(stock);
  params.push(code, short, `${short}.%`);
  return `(${column} = ? OR ${column} = ? OR ${column} LIKE ?)`;
}

function pendingStockWhere(column, stock, params) {
  const { code, short } = stockCodeVariants(stock);
  params.push(code, short, `${code}|C|%`, `${short}|C|%`);
  return `(${column} = ? OR ${column} = ? OR ${column} LIKE ? OR ${column} LIKE ?)`;
}

async function getSnapshot(since = 0, stock = "") {
  const db = getPool();
  const want = String(stock || "").trim() ? normalizeStockCode(stock) : "";
  const params = [];
  let sql = `SELECT account, stock, payload, updated_at, UNIX_TIMESTAMP(updated_at) AS updated_at_unix, version
     FROM sync_snapshot`;
  if (want) {
    sql += ` WHERE ${snapshotStockWhere("stock", want, params)}`;
  }
  sql += ` ORDER BY version DESC, updated_at DESC LIMIT 1`;
  const [rows] = await db.query(sql, params);
  if (!rows.length) {
    return { ...emptySnapshot(), stock: want };
  }
  const row = rows[0];
  const version = Number(row.version) || 0;
  const rowStock = normalizeStockCode(row.stock || want);
  const pendingHangs = await listHangRequests({ stock: rowStock });
  const pendingCancels = await listCancelRequests({ stock: rowStock });
  const failedHangs = await listFailedHangs({ stock: rowStock });
  const payload = parsePayload(row.payload) || {};
  let lastDeal = await getLastDeal(rowStock);
  if (String(payload.source || "") !== "sim" && row.account !== "SIM") {
    const assumedDate = shanghaiDateDigits(toEpochMs(row.updated_at_unix, row.updated_at));
    const fresh = pickLastDeal(payload.deals, assumedDate);
    if (fresh && (!lastDeal || fresh.rank > lastDeal.rank)) {
      lastDeal = fresh;
      await rememberLastDeal(rowStock, payload.deals, assumedDate).catch((err) => console.error("rememberLastDeal failed:", err.message));
    }
  }
  if (since > 0 && version > 0 && since >= version) {
    return {
      unchanged: true,
      version,
      stock: rowStock,
      updatedAt: toEpochMs(row.updated_at_unix, row.updated_at),
      pendingHangs,
      pendingCancels,
      failedHangs,
      lastDeal,
    };
  }
  const updatedAt = toEpochMs(row.updated_at_unix, row.updated_at);
  const orders = payload.orders || [];
  return {
    unchanged: false,
    version,
    ...payload,
    updatedAt,
    account: payload.account || row.account,
    stock: normalizeStockCode(payload.stock || row.stock || want),
    openOrders: payload.openOrders || [],
    orders,
    deals: payload.deals || [],
    pendingHangs,
    landingHangs: await listLandingHangs(rowStock, orders),
    pendingCancels,
    failedHangs,
    lastDeal,
  };
}

const DEBUG_LEVELS = new Set(["debug", "info", "warn", "error"]);

function cleanDebugField(value, max) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

async function appendDebug(lines, { source = "", runId = "", auth = "" } = {}) {
  if (!lines.length) {
    return { accepted: 0, lastId: await maxDebugId() };
  }
  const db = getPool();
  const values = lines.map((line) => {
    const level = cleanDebugField(line.level, 16).toLowerCase();
    return [
      cleanDebugField(line.ts, 40) || new Date().toISOString(),
      DEBUG_LEVELS.has(level) ? level : "info",
      String(line.message == null ? "" : line.message).slice(0, 8000),
      cleanDebugField(line.source || source, 32),
      cleanDebugField(line.runId || runId, 32),
      cleanDebugField(auth, 16),
    ];
  });
  await db.query(`INSERT INTO debug_log (ts, level, message, source, run_id, auth) VALUES ?`, [values]);
  return { accepted: lines.length, lastId: await maxDebugId() };
}

async function maxDebugId() {
  const db = getPool();
  const [rows] = await db.query(`SELECT MAX(id) AS lastId FROM debug_log`);
  return Number(rows[0] && rows[0].lastId) || 0;
}

async function getDebug({ after = 0, tail = 0, source = "", level = "", runId = "", q = "", sinceMinutes = 0, limit = 500 } = {}) {
  const db = getPool();
  const lastId = await maxDebugId();
  const where = ["id > ?"];
  const params = [Math.max(0, Number(after) || 0)];
  if (source) {
    where.push("source = ?");
    params.push(String(source).slice(0, 32));
  }
  if (level === "error") {
    where.push("level = 'error'");
  } else if (level === "warn") {
    where.push("level IN ('warn', 'error')");
  }
  if (runId) {
    where.push("run_id = ?");
    params.push(String(runId).slice(0, 32));
  }
  if (q) {
    where.push("message LIKE ?");
    params.push(`%${String(q).slice(0, 200)}%`);
  }
  if (Number(sinceMinutes) > 0) {
    where.push("created_at >= NOW(3) - INTERVAL ? MINUTE");
    params.push(Math.min(Number(sinceMinutes), 60 * 24 * 30));
  }
  const cols = "id, ts, level, source, run_id AS runId, auth, message, created_at AS createdAt";
  const cap = Math.max(1, Math.min(2000, Number(tail) > 0 ? Number(tail) : Number(limit) || 500));
  const sql = Number(tail) > 0
    ? `SELECT * FROM (SELECT ${cols} FROM debug_log WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?) t ORDER BY id ASC`
    : `SELECT ${cols} FROM debug_log WHERE ${where.join(" AND ")} ORDER BY id ASC LIMIT ?`;
  params.push(cap);
  const [rows] = await db.query(sql, params);
  const nextAfter = rows.length ? Number(rows[rows.length - 1].id) : Math.max(0, Number(after) || 0);
  return { lastId, nextAfter, items: rows };
}

async function health() {
  const db = getPool();
  await db.query("SELECT 1");
  const snapshot = await getSnapshot();
  const lastId = await maxDebugId();
  const [pendingRows] = await db.query(
    `SELECT COUNT(*) AS c FROM pending_orders WHERE status IN ('pending', 'claimed')`
  );
  return {
    ok: true,
    db: true,
    updatedAt: snapshot.updatedAt,
    version: snapshot.version || 0,
    logCount: lastId,
    pendingOrders: Number(pendingRows[0] && pendingRows[0].c) || 0,
  };
}

function roundPrice(price) {
  return Math.round(Number(price) * 1000) / 1000;
}

async function createHangOrder({ account, stock, side, price, qty, source = "ui", coverQty = 0 }) {
  const s = String(side || "").toLowerCase();
  if (s !== "buy" && s !== "sell") {
    const err = new Error("side must be buy or sell");
    err.status = 400;
    throw err;
  }
  const px = roundPrice(price);
  const q = Math.round(Number(qty));
  if (!(px > 0)) {
    const err = new Error("invalid price");
    err.status = 400;
    throw err;
  }
  if (!(q > 0) || q % 100 !== 0) {
    const err = new Error("qty must be positive multiple of 100");
    err.status = 400;
    throw err;
  }

  const snapshot = await getSnapshot(0, String(stock || "").trim());
  const snapStock = normalizeStockCode(stock || snapshot.stock || "");
  const snapAccount = String(account || snapshot.account || "").trim();
  if (!snapStock) {
    const err = new Error("stock required");
    err.status = 400;
    throw err;
  }

  const bid1 = Number(snapshot.bid1) || 0;
  const ask1 = Number(snapshot.ask1) || 0;
  if (s === "buy") {
    if (!(bid1 > 0) || !(px <= bid1 + 1e-9)) {
      const err = new Error(`买挂只能在买1及下方（买1=${bid1 || "--"}）`);
      err.status = 400;
      throw err;
    }
  } else if (!(ask1 > 0) || !(px >= ask1 - 1e-9)) {
    const err = new Error(`卖挂只能在卖1及上方（卖1=${ask1 || "--"}）`);
    err.status = 400;
    throw err;
  }

  const db = getPool();
  const cover = Math.round(Number(coverQty) || 0);
  if (source === "cruise" && cover > 0) {
    const placed = await insertCruiseHang({
      db,
      account: snapAccount,
      stock: snapStock,
      side: s,
      price: px,
      qty: q,
      coverQty: cover,
      source,
      snapshot,
    });
    return placed;
  }
  const [result] = await db.query(
    `INSERT INTO pending_orders (account, stock, side, price, qty, status, source, action)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, 'hang')`,
    [snapAccount, snapStock, s, px, q, source]
  );
  return getHangOrder(result.insertId);
}

const OPEN_HANG_STATUS = new Set([48, 49, 50, 51, 52, 55]);

function snapshotOpenQty(snapshot, side, price) {
  const rows = snapshot && snapshot.orders && snapshot.orders.length ? snapshot.orders : (snapshot && snapshot.openOrders) || [];
  let qty = 0;
  for (const row of rows) {
    const status = Number(row.m_nOrderStatus || row.status);
    const remaining = Number(row.m_nVolumeTotal);
    if (!OPEN_HANG_STATUS.has(status) || !(remaining > 0)) continue;
    const name = String(row.m_strOptName || row.side || "");
    const rowSide = name.includes("卖") ? "sell" : name.includes("买") ? "buy" : "";
    if (rowSide !== side) continue;
    if (roundPrice(row.m_dLimitPrice || row.price) !== price) continue;
    qty += remaining;
  }
  return qty;
}

async function insertCruiseHang({ db, account, stock, side, price, qty, coverQty, source, snapshot }) {
  const lockName = `qmt:${stock}:${side}:${price}`.slice(0, 64);
  const conn = await db.getConnection();
  try {
    const [lockRows] = await conn.query(`SELECT GET_LOCK(?, 5) AS locked`, [lockName]);
    if (!lockRows[0] || Number(lockRows[0].locked) !== 1) {
      const err = new Error("挂单锁超时");
      err.status = 503;
      throw err;
    }
    try {
      const { code, short } = stockCodeVariants(stock);
      const [pendRows] = await conn.query(
        `SELECT COALESCE(SUM(qty), 0) AS qty
         FROM pending_orders
         WHERE status IN ('pending', 'claimed')
           AND (action = 'hang' OR action IS NULL OR action = '')
           AND stock NOT LIKE '%|C|%'
           AND (stock = ? OR stock = ?)
           AND side = ?
           AND ROUND(price, 3) = ?`,
        [code, short, side, price]
      );
      const landing = (snapshot.landingHangs || [])
        .filter((row) => row.side === side && roundPrice(row.price) === price)
        .reduce((sum, row) => sum + Number(row.qty || 0), 0);
      const have = snapshotOpenQty(snapshot, side, price) + Number(pendRows[0] && pendRows[0].qty) + landing;
      const room = Math.floor((coverQty - have) / 100) * 100;
      if (!(room > 0)) return { covered: true };
      const placeQty = Math.min(qty, room);
      const [result] = await conn.query(
        `INSERT INTO pending_orders (account, stock, side, price, qty, status, source, action)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, 'hang')`,
        [account, stock, side, price, placeQty, source]
      );
      return getHangOrder(result.insertId);
    } finally {
      await conn.query(`SELECT RELEASE_LOCK(?)`, [lockName]);
    }
  } finally {
    conn.release();
  }
}

async function getHangOrder(id) {
  const db = getPool();
  const [rows] = await db.query(`SELECT * FROM pending_orders WHERE id = ?`, [id]);
  return rows[0] || null;
}

function mapPendingRow(row) {
  const stockRaw = String(row.stock || "");
  let stock = stockRaw;
  let target = row.target_order_id || "";
  let action = row.action || "hang";
  if (stockRaw.includes("|C|")) {
    const parts = stockRaw.split("|C|");
    stock = parts[0] || stock;
    target = target || parts[1] || "";
    action = "cancel";
  }
  return {
    id: row.id,
    account: row.account,
    stock,
    side: row.side,
    price: Number(row.price),
    qty: Number(row.qty),
    status: row.status,
    source: row.source || "",
    errorMessage: row.error_message || "",
    action,
    targetOrderId: target,
    createdAt: row.created_at instanceof Date ? row.created_at.getTime() : row.created_at,
  };
}

// A hang QMT already placed ('done') stays invisible until the next status push lists it in
// snapshot.orders. Until a matching order (same side/price, inserted no earlier than the
// request) shows up, it is still reported so nothing re-fills that slot or re-anchors around it.
const LANDING_WINDOW_SEC = 120;

const shanghaiStamp = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function orderInsertStamp(row) {
  const d = String(row.m_strInsertDate || row.date || "").replace(/\D/g, "");
  const t = String(row.m_strInsertTime || row.time || "").replace(/\D/g, "");
  if (d.length < 8 || t.length < 5) return "";
  return d.slice(0, 8) + t.padStart(6, "0").slice(0, 6);
}

async function listLandingHangs(stock, orders, windowSec = LANDING_WINDOW_SEC) {
  const db = getPool();
  const { code, short } = stockCodeVariants(stock);
  const [rows] = await db.query(
    `SELECT id, account, stock, side, price, qty, status, action, target_order_id, created_at,
            UNIX_TIMESTAMP(created_at) AS created_unix
     FROM pending_orders
     WHERE status = 'done'
       AND (action = 'hang' OR action IS NULL OR action = '')
       AND stock NOT LIKE '%|C|%'
       AND (stock = ? OR stock = ?)
       AND finished_at >= NOW(3) - INTERVAL ? SECOND
     ORDER BY id ASC`,
    [code, short, windowSec]
  );
  if (!rows.length) return [];
  const pool = [];
  for (const row of orders || []) {
    const name = String(row.m_strOptName || row.side || "");
    const side = name.includes("卖") ? "sell" : name.includes("买") ? "buy" : "";
    const stamp = orderInsertStamp(row);
    if (side && stamp) pool.push({ side, price: roundPrice(row.m_dLimitPrice || row.price), stamp, used: false });
  }
  const out = [];
  for (const row of rows) {
    const side = String(row.side || "").toLowerCase();
    const price = roundPrice(row.price);
    const since = shanghaiStamp.format(new Date((Number(row.created_unix) - 1) * 1000)).replace(/\D/g, "");
    const hit = pool.find((o) => !o.used && o.side === side && o.price === price && o.stamp >= since);
    if (hit) hit.used = true;
    else out.push({ ...mapPendingRow(row), status: "landing" });
  }
  return out;
}

async function listHangRequests({ stock = "" } = {}) {
  const db = getPool();
  const params = [];
  let sql = `SELECT id, account, stock, side, price, qty, status, action, target_order_id, created_at
     FROM pending_orders
     WHERE status IN ('pending', 'claimed')
       AND (action = 'hang' OR action IS NULL OR action = '')
       AND stock NOT LIKE '%|C|%'`;
  if (stock) {
    const { code, short } = stockCodeVariants(stock);
    sql += ` AND (stock = ? OR stock = ?)`;
    params.push(code, short);
  }
  sql += ` ORDER BY id ASC`;
  const [rows] = await db.query(sql, params);
  return rows.map(mapPendingRow);
}

async function listFailedHangs({ stock = "", limit = 30 } = {}) {
  const db = getPool();
  const params = [];
  let sql = `SELECT id, account, stock, side, price, qty, status, source, action, target_order_id, error_message, created_at
     FROM pending_orders
     WHERE status = 'failed'
       AND (action = 'hang' OR action IS NULL OR action = '')
       AND stock NOT LIKE '%|C|%'`;
  if (stock) {
    const { code, short } = stockCodeVariants(stock);
    sql += ` AND (stock = ? OR stock = ?)`;
    params.push(code, short);
  }
  sql += ` ORDER BY id DESC LIMIT ?`;
  params.push(Math.max(1, Math.min(100, Number(limit) || 30)));
  const [rows] = await db.query(sql, params);
  return rows.map(mapPendingRow);
}

async function listCancelRequests({ stock = "" } = {}) {
  const db = getPool();
  const params = [];
  let sql = `SELECT id, account, stock, side, price, qty, status, action, target_order_id, created_at
     FROM pending_orders
     WHERE status IN ('pending', 'claimed')
       AND (action = 'cancel' OR stock LIKE '%|C|%')`;
  if (stock) {
    sql += ` AND ${pendingStockWhere("stock", stock, params)}`;
  }
  sql += ` ORDER BY id ASC`;
  const [rows] = await db.query(sql, params);
  return rows.map(mapPendingRow);
}

async function listPendingCommands({ limit = 20 } = {}) {
  const db = getPool();
  const [rows] = await db.query(
    `SELECT id, account, stock, side, price, qty, status, action, target_order_id, created_at
     FROM pending_orders
     WHERE status = 'pending'
     ORDER BY id ASC
     LIMIT ?`,
    [Math.max(1, Math.min(100, Number(limit) || 20))]
  );
  return rows.map(mapPendingRow);
}

async function createCancelOrder({ account, stock, side, price, qty, targetOrderId, source = "ui" }) {
  const target = String(targetOrderId || "").trim();
  if (!target) {
    const err = new Error("缺少委托号");
    err.status = 400;
    throw err;
  }
  const s = String(side || "").toLowerCase();
  if (s !== "buy" && s !== "sell") {
    const err = new Error("side must be buy or sell");
    err.status = 400;
    throw err;
  }
  const snapshot = await getSnapshot(0, String(stock || "").trim());
  const snapStock = normalizeStockCode(stock || snapshot.stock || "");
  const snapAccount = String(account || snapshot.account || "").trim();
  if (!snapStock) {
    const err = new Error("stock required");
    err.status = 400;
    throw err;
  }
  const db = getPool();
  const [dup] = await db.query(
    `SELECT id FROM pending_orders
     WHERE action = 'cancel' AND target_order_id = ? AND status IN ('pending', 'claimed')
     LIMIT 1`,
    [target]
  );
  if (dup[0]) {
    return getHangOrder(dup[0].id);
  }
  const px = roundPrice(price) || 0;
  const q = Math.max(0, Math.round(Number(qty) || 0));
  // stock 写成 CODE|C|委托号：旧版 Cloud 若不下发 action，策略仍能识别为撤单，避免再下单
  const stockToken = `${snapStock}|C|${target}`;
  const [result] = await db.query(
    `INSERT INTO pending_orders (account, stock, side, price, qty, status, source, action, target_order_id)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, 'cancel', ?)`,
    [snapAccount, stockToken, s, px, q, source, target]
  );
  return getHangOrder(result.insertId);
}

async function claimHangOrder(id) {
  const db = getPool();
  const [result] = await db.query(
    `UPDATE pending_orders
     SET status = 'claimed', claimed_at = CURRENT_TIMESTAMP(3)
     WHERE id = ? AND status = 'pending'`,
    [id]
  );
  if (!result.affectedRows) {
    return null;
  }
  return getHangOrder(id);
}

async function finishHangOrder(id, { ok, brokerOrderId = "", errorMessage = "" } = {}) {
  const db = getPool();
  const status = ok ? "done" : "failed";
  const [result] = await db.query(
    `UPDATE pending_orders
     SET status = ?, broker_order_id = ?, error_message = ?, finished_at = CURRENT_TIMESTAMP(3)
     WHERE id = ? AND status IN ('pending', 'claimed')`,
    [status, String(brokerOrderId || "").slice(0, 64), String(errorMessage || "").slice(0, 512), id]
  );
  if (!result.affectedRows) {
    return null;
  }
  return getHangOrder(id);
}

function normalizeStockCode(stock) {
  const raw = String(stock || "").trim().toUpperCase();
  if (!raw) return "";
  const short = raw.replace(/\.SZ$/, "").replace(/\.SH$/, "");
  if (short === "516310") return "516310.SH";
  if (short === "159781") return "159781.SZ";
  if (raw.endsWith(".SZ") || raw.endsWith(".SH")) return raw;
  return `${raw}.SZ`;
}

function cruiseChannel(value, stock) {
  const s = String(value || "");
  let ch = "live";
  let code = "";
  if (s.includes(":")) {
    const [head, tail] = s.split(":");
    ch = String(head).toLowerCase() === "sim" ? "sim" : "live";
    code = normalizeStockCode(tail || stock);
  } else {
    ch = s.toLowerCase() === "sim" ? "sim" : "live";
    code = normalizeStockCode(stock);
  }
  return `${ch}:${code}`;
}

function cruiseChannelLegacy(book) {
  const s = String(book || "");
  if (s.startsWith("sim")) return "sim";
  return "live";
}

function dealKeyFromRow(row) {
  const tid = String((row && (row.m_strTradeID || row.trade_id || row.m_strDealID || row.m_strExecID)) || "");
  if (tid) return `t:${tid}`;
  const oid = String((row && (row.order_id || row.m_strOrderSysID)) || "");
  const t = String((row && (row.m_strTradeTime || row.time)) || "");
  const px = Number((row && (row.m_dPrice || row.price)) || 0);
  const qty = Number((row && (row.m_nVolume || row.qty)) || 0);
  return `o:${oid}:${t}:${px}:${qty}`;
}

async function listCruiseSeen(username, channel, kind) {
  const db = getPool();
  const [rows] = await db.query(
    `SELECT item_key FROM cruise_seen WHERE username = ? AND channel = ? AND kind = ?`,
    [username, channel, kind]
  );
  return rows.map((row) => String(row.item_key));
}

function parseCruiseBook(raw) {
  if (!raw) return { rungs: [], dropped: [], lastDeal: null, prevDeal: null };
  try {
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    const rungs = Array.isArray(data) ? data : data.rungs;
    const dropped = Array.isArray(data && data.dropped) ? data.dropped : [];
    return {
      rungs: Array.isArray(rungs) ? rungs : [],
      dropped: dropped.map((id) => String(id)).filter(Boolean),
      lastDeal: (data && data.lastDeal) || null,
      prevDeal: (data && data.prevDeal) || null,
    };
  } catch (_err) {
    return { rungs: [], dropped: [], lastDeal: null, prevDeal: null };
  }
}

async function getCruiseState(username, channel, stock) {
  const ch = cruiseChannel(channel, stock);
  const db = getPool();
  let [rows] = await db.query(
    `SELECT cruise_on, rungs_json, hang_qty, grid_step, reverse_gap, min_spread
     FROM user_cruise WHERE username = ? AND channel = ?`,
    [username, ch]
  );
  if (!rows.length && ch.endsWith(":159781.SZ")) {
    const legacy = cruiseChannelLegacy(ch);
    [rows] = await db.query(
      `SELECT cruise_on, rungs_json FROM user_cruise WHERE username = ? AND channel = ?`,
      [username, legacy]
    );
    if (rows.length) {
      const book = parseCruiseBook(rows[0] && rows[0].rungs_json);
      return {
        on: Boolean(rows[0] && rows[0].cruise_on),
        channel: ch,
        rungs: book.rungs,
        dropped: book.dropped,
        lastDeal: book.lastDeal,
        prevDeal: book.prevDeal,
        seenDeals: await listCruiseSeen(username, legacy, "deal"),
        seenFails: await listCruiseSeen(username, legacy, "fail"),
        step: 0,
        reverseGap: 0,
        minSpread: 0,
      };
    }
  }
  const book = parseCruiseBook(rows[0] && rows[0].rungs_json);
  return {
    on: Boolean(rows[0] && rows[0].cruise_on),
    channel: ch,
    qty: Number(rows[0] && rows[0].hang_qty) || 0,
    rungs: book.rungs,
    dropped: book.dropped,
    lastDeal: book.lastDeal,
    prevDeal: book.prevDeal,
    seenDeals: await listCruiseSeen(username, ch, "deal"),
    seenFails: await listCruiseSeen(username, ch, "fail"),
    step: Number(rows[0] && rows[0].grid_step) || 0,
    reverseGap: Number(rows[0] && rows[0].reverse_gap) || 0,
    minSpread: Number(rows[0] && rows[0].min_spread) || 0,
  };
}

// Grid settings stay on the row while cruise is off. A cruise that is already on cannot be edited.
async function setCruiseGrid(username, stock, grid) {
  const ch = cruiseChannel("live", stock);
  const db = getPool();
  const [existing] = await db.query(
    `SELECT cruise_on FROM user_cruise WHERE username = ? AND channel = ?`,
    [username, ch]
  );
  if (existing.length && Number(existing[0].cruise_on)) {
    return { ok: false, locked: true, error: "巡航已开启，不能修改步长和价差" };
  }
  const params = [grid.step, grid.reverseGap, grid.minSpread];
  if (!existing.length) {
    await db.query(
      `INSERT INTO user_cruise (username, channel, cruise_on, grid_step, reverse_gap, min_spread)
       VALUES (?, ?, 0, ?, ?, ?)`,
      [username, ch, ...params]
    );
  } else {
    const [result] = await db.query(
      `UPDATE user_cruise
       SET grid_step = ?, reverse_gap = ?, min_spread = ?
       WHERE username = ? AND channel = ? AND cruise_on = 0`,
      [...params, username, ch]
    );
    if (!result.affectedRows) {
      return { ok: false, locked: true, error: "巡航已开启，不能修改步长和价差" };
    }
  }
  return { ok: true, state: await getCruiseState(username, "live", stock) };
}

async function setCruiseState(username, channel, on, stock, qty = 0) {
  const ch = cruiseChannel(channel, stock);
  const db = getPool();
  const hangQty = Math.round(Number(qty) || 0) > 0 ? Math.round(Number(qty)) : null;
  await db.query(
    `INSERT INTO user_cruise (username, channel, cruise_on, hang_qty)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE cruise_on = VALUES(cruise_on), hang_qty = COALESCE(VALUES(hang_qty), hang_qty)`,
    [username, ch, on ? 1 : 0, hangQty]
  );
  if (!on) {
    await db.query(
      `UPDATE user_cruise SET lease_holder = NULL, lease_until = NULL WHERE username = ? AND channel = ?`,
      [username, ch]
    );
  }
  if (on) {
    const code = ch.split(":")[1] || "";
    const snap = await getSnapshot(0, code);
    const keys = (snap.deals || []).map(dealKeyFromRow).filter(Boolean);
    if (keys.length) {
      const values = keys.map((key) => [username, ch, "deal", key]);
      await db.query(
        `INSERT IGNORE INTO cruise_seen (username, channel, kind, item_key) VALUES ?`,
        [values]
      );
    }
  } else {
    await db.query(`DELETE FROM cruise_seen WHERE username = ? AND channel = ?`, [username, ch]);
    const [cur] = await db.query(
      `SELECT rungs_json FROM user_cruise WHERE username = ? AND channel = ?`,
      [username, ch]
    );
    const parsed = parseCruiseBook(cur[0] && cur[0].rungs_json);
    await db.query(
      `UPDATE user_cruise SET rungs_json = ? WHERE username = ? AND channel = ?`,
      [JSON.stringify({ rungs: [], dropped: [], lastDeal: parsed.lastDeal, prevDeal: parsed.prevDeal }), username, ch]
    );
  }
  return getCruiseState(username, channel, stock);
}

async function saveCruiseRungs(username, channel, stock, rungs, dropped, lastDeal, prevDeal) {
  const ch = cruiseChannel(channel, stock);
  const book = {
    rungs: Array.isArray(rungs) ? rungs : [],
    dropped: Array.isArray(dropped) ? dropped.map((id) => String(id)).filter(Boolean) : [],
    lastDeal: lastDeal || null,
    prevDeal: prevDeal || null,
  };
  const db = getPool();
  await db.query(
    `INSERT INTO user_cruise (username, channel, cruise_on, rungs_json)
     VALUES (?, ?, 0, ?)
     ON DUPLICATE KEY UPDATE rungs_json = VALUES(rungs_json)`,
    [username, ch, JSON.stringify(book)]
  );
  return getCruiseState(username, channel, stock);
}

async function listActiveCruises() {
  const db = getPool();
  const [rows] = await db.query(
    `SELECT username, channel, hang_qty FROM user_cruise WHERE cruise_on = 1 AND channel LIKE 'live:%'`
  );
  return rows.map((row) => ({
    username: row.username,
    stock: String(row.channel).split(":")[1] || "",
    qty: Number(row.hang_qty) || 0,
  }));
}

// Written only while cruise is on, so a tick finishing after the user turned cruise off
// cannot resurrect rungs that setCruiseState(off) just cleared.
async function saveCruiseBookIfOn(username, stock, book) {
  const ch = cruiseChannel("live", stock);
  const db = getPool();
  const [result] = await db.query(
    `UPDATE user_cruise SET rungs_json = ? WHERE username = ? AND channel = ? AND cruise_on = 1`,
    [JSON.stringify({
      rungs: Array.isArray(book.rungs) ? book.rungs : [],
      dropped: [...(book.dropped || [])].map(String),
      lastDeal: book.lastDeal || null,
      prevDeal: book.prevDeal || null,
    }), username, ch]
  );
  return Boolean(result.affectedRows);
}

async function renewCruiseLease(username, channel, stock, holder) {
  const ch = cruiseChannel(channel, stock);
  const id = String(holder || "").trim().slice(0, 64);
  if (!id) return { held: false, reason: "missing" };
  const db = getPool();
  const [result] = await db.query(
    `UPDATE user_cruise
     SET lease_holder = ?, lease_until = DATE_ADD(NOW(3), INTERVAL 20 SECOND)
     WHERE username = ? AND channel = ?
       AND (
         lease_holder IS NULL
         OR lease_holder = ?
         OR lease_until IS NULL
         OR lease_until < NOW(3)
       )`,
    [id, username, ch, id]
  );
  if (result.affectedRows) return { held: true };
  const [rows] = await db.query(
    `SELECT username FROM user_cruise WHERE username = ? AND channel = ?`,
    [username, ch]
  );
  if (!rows.length) return { held: false, reason: "missing" };
  return { held: false, reason: "busy" };
}

async function releaseCruiseLease(username, channel, stock, holder) {
  const ch = cruiseChannel(channel, stock);
  const id = String(holder || "").trim().slice(0, 64);
  if (!id) return { ok: true };
  const db = getPool();
  await db.query(
    `UPDATE user_cruise
     SET lease_holder = NULL, lease_until = NULL
     WHERE username = ? AND channel = ? AND lease_holder = ?`,
    [username, ch, id]
  );
  return { ok: true };
}

async function claimCruiseSeen(username, channel, kind, key, stock) {
  const ch = cruiseChannel(channel, stock);
  const item = String(key || "").slice(0, 190);
  const k = kind === "fail" ? "fail" : "deal";
  if (!item) return { claimed: false };
  const db = getPool();
  const [result] = await db.query(
    `INSERT IGNORE INTO cruise_seen (username, channel, kind, item_key) VALUES (?, ?, ?, ?)`,
    [username, ch, k, item]
  );
  return { claimed: Boolean(result.affectedRows) };
}

async function unclaimCruiseSeen(username, channel, kind, key, stock) {
  const ch = cruiseChannel(channel, stock);
  const item = String(key || "").slice(0, 190);
  const k = kind === "fail" ? "fail" : "deal";
  if (!item) return { ok: true };
  const db = getPool();
  await db.query(
    `DELETE FROM cruise_seen WHERE username = ? AND channel = ? AND kind = ? AND item_key = ?`,
    [username, ch, k, item]
  );
  return { ok: true };
}

module.exports = {
  ensureSchema,
  saveSnapshot,
  getSnapshot,
  appendDebug,
  getDebug,
  health,
  createHangOrder,
  getHangOrder,
  listHangRequests,
  listCancelRequests,
  listFailedHangs,
  listPendingCommands,
  createCancelOrder,
  claimHangOrder,
  finishHangOrder,
  getCruiseState,
  setCruiseState,
  setCruiseGrid,
  saveCruiseRungs,
  listActiveCruises,
  getLastDeal,
  rememberLastDeal,
  listLandingHangs,
  saveCruiseBookIfOn,
  normalizeStockCode,
  renewCruiseLease,
  releaseCruiseLease,
  claimCruiseSeen,
  unclaimCruiseSeen,
};
