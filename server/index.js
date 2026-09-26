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

function unauthorized(res) {
  res.status(401).json({ ok: false, error: "unauthorized" });
}

function checkToken(req, res, next) {
  if (!TOKEN) {
    return next();
  }
  const got = req.get("x-bridge-token") || req.query.token || "";
  if (got !== TOKEN) {
    return unauthorized(res);
  }
  return next();
}

/** Console UI (cookie) or strategy (bridge token). */
function allowBridgeOrConsole(req, res, next) {
  if (TOKEN) {
    const got = req.get("x-bridge-token") || req.query.token || "";
    if (got === TOKEN) return next();
  }
  const user = auth.currentUser(req);
  if (user) {
    req.username = user;
    return next();
  }
  if (!TOKEN) return next();
  return unauthorized(res);
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
      res.status(400).json({ ok: false, error: "stock required" });
      return;
    }
    res.json(await db.getSnapshot(Number(req.query.since || 0), stock));
  })
);

app.post(
  "/api/debug",
  checkToken,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const lines = Array.isArray(body.lines)
      ? body.lines
      : [{ level: body.level || "info", message: body.message || JSON.stringify(body) }];
    const result = await db.appendDebug(lines);
    res.json({ ok: true, ...result });
  })
);

app.get(
  "/api/debug",
  checkToken,
  asyncHandler(async (req, res) => {
    const after = Number(req.query.after || 0);
    const tail = Number(req.query.tail || 0);
    const result = await db.getDebug({ after, tail });
    res.json({ ok: true, ...result });
  })
);

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
      });
      res.json({ ok: true, order: row });
    } catch (err) {
      const status = err.status || 500;
      res.status(status).json({ ok: false, error: err.message || "hang failed" });
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
      const status = err.status || 500;
      res.status(status).json({ ok: false, error: err.message || "cancel failed" });
    }
  })
);

app.post(
  "/api/commands/:id/claim",
  checkToken,
  asyncHandler(async (req, res) => {
    const row = await db.claimHangOrder(Number(req.params.id));
    if (!row) {
      res.status(409).json({ ok: false, error: "not pending" });
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
    const row = await db.finishHangOrder(Number(req.params.id), {
      ok: Boolean(body.ok),
      brokerOrderId: body.brokerOrderId || body.orderId || "",
      errorMessage: body.error || body.errorMessage || "",
    });
    if (!row) {
      res.status(409).json({ ok: false, error: "not claimable" });
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

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: err.message || "server error" });
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
