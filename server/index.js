const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const pkg = require("../package.json");
const express = require("express");
const db = require("./db");
const auth = require("./auth");

const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.BRIDGE_TOKEN || "";

app.use(express.json({ limit: "2mb" }));

app.post("/api/login", (req, res) => {
  const body = req.body || {};
  const result = auth.tryLogin(body.username, body.password);
  if (!result.ok) {
    res.status(401).json({ ok: false, error: "用户名或密码错误" });
    return;
  }
  if (!result.open) {
    auth.setSessionCookie(req, res, result.user);
  }
  res.json({ ok: true, user: result.user });
});

app.post("/api/logout", (req, res) => {
  auth.clearSessionCookie(req, res);
  res.json({ ok: true });
});

app.get("/api/session", (req, res) => {
  if (!auth.websiteAuthEnabled()) {
    res.json({ ok: true, auth: false, user: auth.USER });
    return;
  }
  const sess = auth.readSession(req);
  if (!sess) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }
  res.json({ ok: true, auth: true, user: sess.user });
});

app.get(["/", "/index.html"], auth.requirePageLogin, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use(express.static(path.join(__dirname, "public")));

function fingerprint(value) {
  if (!value) return "";
  return require("crypto").createHash("sha256").update(String(value)).digest("hex").slice(0, 8);
}

function sendFail(req, res, status, code, error, extra = {}) {
  res.set("X-QMT-Reason", code);
  res.status(status).json({
    ok: false,
    code,
    error,
    method: req.method,
    path: req.originalUrl.split("?")[0],
    ...extra,
  });
}

function bridgeToken(req) {
  const header = req.get("x-bridge-token");
  if (header != null) return { got: header, from: "header X-Bridge-Token" };
  if (req.query.token != null) return { got: String(req.query.token), from: "query token" };
  return { got: "", from: "" };
}

function tokenFailure(req, res, { allowCookie = false } = {}) {
  const { got, from } = bridgeToken(req);
  const tokenInfo = {
    expectedLength: TOKEN.length,
    expectedFingerprint: fingerprint(TOKEN),
    receivedFrom: from || "none",
    receivedLength: got.length,
    receivedFingerprint: fingerprint(got),
    cookieSession: allowCookie ? Boolean(auth.readSession(req)) : undefined,
  };
  if (!got) {
    sendFail(
      req,
      res,
      401,
      "BRIDGE_TOKEN_MISSING",
      allowCookie
        ? "未登录网页，且请求没有带 X-Bridge-Token；服务器已配置 BRIDGE_TOKEN，策略里的 TOKEN 需要填成相同的值"
        : "请求没有带 X-Bridge-Token；服务器已配置 BRIDGE_TOKEN，策略里的 TOKEN 需要填成相同的值",
      tokenInfo
    );
    return;
  }
  if (got.trim() === TOKEN) {
    sendFail(req, res, 401, "BRIDGE_TOKEN_WHITESPACE", "X-Bridge-Token 首尾带有空格或换行，去掉后才与 BRIDGE_TOKEN 一致", tokenInfo);
    return;
  }
  sendFail(
    req,
    res,
    401,
    "BRIDGE_TOKEN_MISMATCH",
    "X-Bridge-Token 与服务器 BRIDGE_TOKEN 不一致；可对比两边的 length 和 fingerprint（sha256 前 8 位）",
    tokenInfo
  );
}

function checkToken(req, res, next) {
  if (!TOKEN) {
    return next();
  }
  if (bridgeToken(req).got === TOKEN) return next();
  return tokenFailure(req, res);
}

/** Console UI (cookie) or strategy (bridge token). */
function allowBridgeOrConsole(req, res, next) {
  if (TOKEN && bridgeToken(req).got === TOKEN) return next();
  const user = auth.currentUser(req);
  if (user) {
    req.username = user;
    return next();
  }
  if (!TOKEN) return next();
  return tokenFailure(req, res, { allowCookie: true });
}

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

app.get(
  "/api/health",
  asyncHandler(async (_req, res) => {
    const h = await db.health();
    res.json({ ...h, appVersion: pkg.version });
  })
);

app.post(
  "/api/sync",
  checkToken,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const saved = await db.saveSnapshot(body);
    res.json({
      ok: true,
      updatedAt: saved.updatedAt,
      version: saved.version,
      unchanged: saved.unchanged,
      counts: {
        openOrders: (body.openOrders || []).length,
        orders: (body.orders || []).length,
        deals: (body.deals || []).length,
      },
    });
  })
);

app.get(
  "/api/state",
  allowBridgeOrConsole,
  asyncHandler(async (req, res) => {
    const stock = String(req.query.stock || "").trim();
    if (!stock) {
      sendFail(req, res, 400, "STOCK_REQUIRED", "缺少 stock 参数，例如 ?stock=159781.SZ");
      return;
    }
    res.json(await db.getSnapshot(Number(req.query.since || 0), stock));
  })
);

const LOG_BATCH_MAX = 500;

function tokenState(req) {
  if (!TOKEN) return "open";
  const { got } = bridgeToken(req);
  if (!got) return "missing";
  return got === TOKEN ? "ok" : "mismatch";
}

// Accepts writes without a valid token so auth problems themselves can be logged; each row records `auth`.
const writeLogs = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const lines = Array.isArray(body.lines)
    ? body.lines
    : [{ level: body.level || "info", message: body.message == null ? JSON.stringify(body) : body.message }];
  if (lines.length > LOG_BATCH_MAX) {
    sendFail(req, res, 413, "LOG_BATCH_TOO_LARGE", `一次最多 ${LOG_BATCH_MAX} 行，本次 ${lines.length} 行`);
    return;
  }
  const auth = tokenState(req);
  const result = await db.appendDebug(lines, {
    source: body.source || req.get("x-qmt-source") || "",
    runId: body.runId || "",
    auth,
  });
  res.json({ ok: true, auth, ...result });
});

function formatLogLine(item) {
  const ts = String(item.ts || item.createdAt || "");
  const tag = [item.source || "-", item.runId || "-", item.auth && item.auth !== "ok" ? `auth=${item.auth}` : ""]
    .filter(Boolean)
    .join(" ");
  return `${item.id} ${ts} ${String(item.level || "info").toUpperCase()} [${tag}] ${item.message}`;
}

const readLogs = asyncHandler(async (req, res) => {
  const q = req.query;
  const result = await db.getDebug({
    after: q.after,
    tail: q.tail,
    source: q.source,
    level: String(q.level || "").toLowerCase(),
    runId: q.run || q.runId,
    q: q.q,
    sinceMinutes: q.since,
    limit: q.limit,
  });
  if (String(q.format || "").toLowerCase() === "text") {
    res.type("text/plain; charset=utf-8");
    res.set("X-Log-Last-Id", String(result.lastId));
    res.set("X-Log-Next-After", String(result.nextAfter));
    res.send(result.items.map(formatLogLine).join("\n") + (result.items.length ? "\n" : ""));
    return;
  }
  res.json({ ok: true, ...result });
});

const STRATEGY_DIR = path.join(__dirname, "..", "strategies");
const STRATEGIES = {
  order_status: "qmt_order_status.py",
  order_exec: "qmt_order_exec.py",
};

function readStrategy(id) {
  const file = STRATEGIES[id];
  if (!file) return null;
  const code = require("fs").readFileSync(path.join(STRATEGY_DIR, file), "utf8");
  const sha256 = require("crypto").createHash("sha256").update(code, "utf8").digest("hex");
  const m = code.match(/^STRATEGY_VERSION\s*=\s*['"]([^'"]+)['"]/m);
  return { id, file, version: m ? m[1] : "", sha256, bytes: Buffer.byteLength(code, "utf8"), code };
}

app.use("/api/strategies", (req, res, next) => {
  const started = Date.now();
  const tokenAtStart = tokenState(req);
  res.on("finish", () => {
    const ua = String(req.get("user-agent") || "").slice(0, 80);
    const ip = String(req.get("cf-connecting-ip") || req.get("x-forwarded-for") || req.ip || "").split(",")[0].trim();
    const reason = res.get("X-QMT-Reason") || "";
    db.appendDebug(
      [{
        level: res.statusCode < 400 ? "info" : "error",
        message: `download ${req.method} ${req.originalUrl.split("?")[0]} -> ${res.statusCode}${reason ? ` ${reason}` : ""} token=${tokenAtStart} ip=${ip} ua=${ua} ${Date.now() - started}ms`,
      }],
      { source: "server", auth: tokenAtStart }
    ).catch((err) => console.error("strategy access log failed:", err.message));
  });
  next();
});

app.get(
  "/api/strategies",
  checkToken,
  asyncHandler(async (_req, res) => {
    const items = Object.keys(STRATEGIES).map((id) => {
      const { code, ...meta } = readStrategy(id);
      return meta;
    });
    res.json({ ok: true, items });
  })
);

app.get(
  "/api/strategies/:id",
  checkToken,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id || "");
    const found = readStrategy(id);
    if (!found) {
      sendFail(req, res, 404, "STRATEGY_NOT_FOUND", `没有这个策略：${id}`, { available: Object.keys(STRATEGIES) });
      return;
    }
    res.json({ ok: true, ...found });
  })
);

app.post(["/api/logs", "/api/debug"], writeLogs);
app.get(["/api/logs", "/api/debug"], allowBridgeOrConsole, readLogs);

app.get(
  "/api/commands",
  checkToken,
  asyncHandler(async (req, res) => {
    const commands = await db.listPendingCommands({ limit: Number(req.query.limit || 20) });
    res.json({ ok: true, commands });
  })
);

app.post(
  "/api/hang",
  allowBridgeOrConsole,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    try {
      const row = await db.createHangOrder({
        account: body.account,
        stock: body.stock,
        side: body.side,
        price: body.price,
        qty: body.qty,
        source: body.source || "ui",
        coverQty: body.coverQty,
      });
      if (row && row.covered) {
        res.json({ ok: true, covered: true });
        return;
      }
      res.json({ ok: true, order: row });
    } catch (err) {
      sendFail(req, res, err.status || 500, err.status ? "HANG_REJECTED" : "HANG_ERROR", err.message || "hang failed");
    }
  })
);

app.post(
  "/api/cancel",
  allowBridgeOrConsole,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    try {
      const row = await db.createCancelOrder({
        account: body.account,
        stock: body.stock,
        side: body.side,
        price: body.price,
        qty: body.qty,
        targetOrderId: body.targetOrderId || body.orderId,
        source: body.source || "ui",
      });
      res.json({ ok: true, order: row });
    } catch (err) {
      sendFail(req, res, err.status || 500, err.status ? "CANCEL_REJECTED" : "CANCEL_ERROR", err.message || "cancel failed");
    }
  })
);

app.post(
  "/api/commands/:id/claim",
  checkToken,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const row = await db.claimHangOrder(id);
    if (!row) {
      const cur = await db.getHangOrder(id);
      sendFail(
        req,
        res,
        409,
        cur ? "COMMAND_NOT_PENDING" : "COMMAND_NOT_FOUND",
        cur ? `指令 #${id} 当前状态是 ${cur.status}，不能再领取` : `指令 #${id} 不存在`,
        cur ? { commandStatus: cur.status } : {}
      );
      return;
    }
    res.json({
      ok: true,
      command: {
        id: row.id,
        account: row.account,
        stock: row.stock,
        side: row.side,
        price: Number(row.price),
        qty: Number(row.qty),
        status: row.status,
        action: row.action || "hang",
        targetOrderId: row.target_order_id || "",
      },
    });
  })
);

app.post(
  "/api/commands/:id/result",
  allowBridgeOrConsole,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const id = Number(req.params.id);
    const row = await db.finishHangOrder(id, {
      ok: Boolean(body.ok),
      brokerOrderId: body.brokerOrderId || body.orderId || "",
      errorMessage: body.error || body.errorMessage || "",
    });
    if (!row) {
      const cur = await db.getHangOrder(id);
      sendFail(
        req,
        res,
        409,
        cur ? "COMMAND_ALREADY_FINISHED" : "COMMAND_NOT_FOUND",
        cur ? `指令 #${id} 当前状态是 ${cur.status}，不能再回报结果` : `指令 #${id} 不存在`,
        cur ? { commandStatus: cur.status } : {}
      );
      return;
    }
    res.json({ ok: true, order: row });
  })
);

app.get(
  "/api/cruise",
  auth.requireUser,
  asyncHandler(async (req, res) => {
    const state = await db.getCruiseState(req.username, req.query.channel, req.query.stock);
    res.json({ ok: true, ...state });
  })
);

app.post(
  "/api/cruise",
  auth.requireUser,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const state = await db.setCruiseState(req.username, body.channel, Boolean(body.on), body.stock);
    res.json({ ok: true, ...state });
  })
);

app.post(
  "/api/cruise/rungs",
  auth.requireUser,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const state = await db.saveCruiseRungs(
      req.username,
      body.channel,
      body.stock,
      body.rungs,
      body.dropped,
      body.lastDeal,
      body.prevDeal
    );
    res.json({ ok: true, ...state });
  })
);

app.post(
  "/api/cruise/lease",
  auth.requireUser,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const out = await db.renewCruiseLease(req.username, body.channel, body.stock, body.holder);
    res.json({ ok: true, ...out });
  })
);

app.post(
  "/api/cruise/lease/release",
  auth.requireUser,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const out = await db.releaseCruiseLease(req.username, body.channel, body.stock, body.holder);
    res.json({ ok: true, ...out });
  })
);

app.post(
  "/api/cruise/claim",
  auth.requireUser,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const out = await db.claimCruiseSeen(req.username, body.channel, body.kind, body.key, body.stock);
    res.json({ ok: true, ...out });
  })
);

app.post(
  "/api/cruise/unclaim",
  auth.requireUser,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const out = await db.unclaimCruiseSeen(req.username, body.channel, body.kind, body.key, body.stock);
    res.json({ ok: true, ...out });
  })
);

app.use("/api", (req, res) => {
  sendFail(req, res, 404, "API_NOT_FOUND", `没有这个接口：${req.method} ${req.originalUrl.split("?")[0]}`);
});

app.use((err, req, res, _next) => {
  if (err && err.type === "entity.parse.failed") {
    sendFail(req, res, 400, "BAD_JSON", `请求体不是合法 JSON：${err.message}`);
    return;
  }
  if (err && err.type === "entity.too.large") {
    sendFail(req, res, 413, "BODY_TOO_LARGE", `请求体超过 2mb 上限：${err.message}`);
    return;
  }
  console.error(err);
  const status = Number(err && err.status) || 500;
  sendFail(req, res, status, status >= 500 ? "SERVER_ERROR" : "REQUEST_ERROR", (err && err.message) || "server error", {
    detail: err && err.code ? String(err.code) : undefined,
  });
});

async function main() {
  await db.ensureSchema();
  app.listen(PORT, () => {
    console.log(`qmt-bridge listening on ${PORT}, mysql ${process.env.MYSQL_HOST}/${process.env.MYSQL_DATABASE}`);
    if (!TOKEN) {
      console.log("BRIDGE_TOKEN is empty: strategy/API token is open.");
    }
    if (!auth.websiteAuthEnabled()) {
      console.log("CONSOLE_PASSWORD is empty: website login is open.");
    } else {
      console.log(`website login required (user=${auth.USER})`);
    }
  });
}

main().catch((err) => {
  console.error("failed to start:", err);
  process.exit(1);
});
