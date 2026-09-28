// Server-side cruise engine. Runs independently of any browser: every TICK_MS it walks all
// users/stocks with cruise_on=1, takes the per-stock DB lease, reads the latest QMT snapshot
// and places cruise hangs into pending_orders (executed by the QMT order_exec strategy).
const os = require("os");
const db = require("./db");

const TICK = 0.001;
const SCALE = Math.round(1 / TICK);
const TICK_MS = 3000;
const OPEN_STATUS = new Set([48, 49, 50, 51, 52, 55]);
const CANCEL_STATUS = new Set([53, 54, 57]);
const HOLDER = `srv:${os.hostname()}:${process.pid}`.slice(0, 64);

const PROFILES = {
  "159781.SZ": { id: "159781.SZ", label: "159781", buyStep: 0.001, sellStep: 0.001, reverseGap: 0.011, minSpread: 0.012, levels: 10, qtyDefault: 10000 },
  "516310.SH": { id: "516310.SH", label: "516310", buyStep: 0.005, sellStep: 0.005, reverseGap: 0.006, minSpread: 0.006, levels: 10, qtyDefault: 10000 },
};

function profileOf(stock) {
  return PROFILES[db.normalizeStockCode(stock)] || null;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function optSide(row) {
  const name = String(row.m_strOptName || row.side || "");
  if (name.includes("卖")) return "sell";
  if (name.includes("买")) return "buy";
  return "";
}

const statusCode = (row) => num(row.m_nOrderStatus || row.status);
const orderPrice = (row) => num(row.m_dLimitPrice || row.price);
const dealPrice = (row) => num(row.m_dPrice || row.price);
const priceToIdx = (price) => Math.round(num(price) * SCALE);
const idxToPrice = (idx) => idx / SCALE;
const roundTickPx = (px) => Math.round(num(px) * SCALE) / SCALE;
const stepTicks = (step) => Math.max(1, Math.round(step * SCALE));
const orderRows = (data) => (data && data.orders && data.orders.length ? data.orders : (data && data.openOrders) || []);
const orderRowId = (row) => String((row && (row.order_id || row.m_strOrderSysID || row.m_strOrderRef)) || "");

function snapQty(qty, profile) {
  const n = Math.floor(num(qty) / 100) * 100;
  return n > 0 ? n : profile.qtyDefault;
}

// Cruises enabled by the old browser engine have no stored hang_qty; their per-rung size
// lives in the saved rungs, so use the most common rung qty before the profile default.
function inferRungQty(rungs) {
  const counts = new Map();
  for (const rung of rungs || []) {
    const q = Math.floor(num(rung && rung.qty) / 100) * 100;
    if (q > 0) counts.set(q, (counts.get(q) || 0) + 1);
  }
  let best = 0;
  let bestCount = 0;
  for (const [q, c] of counts) {
    if (c > bestCount || (c === bestCount && q < best)) {
      best = q;
      bestCount = c;
    }
  }
  return best;
}

function dealKey(row) {
  const tid = String(row.m_strTradeID || row.trade_id || row.m_strDealID || row.m_strExecID || "");
  if (tid) return `t:${tid}`;
  const oid = String(row.order_id || row.m_strOrderSysID || "");
  const t = String(row.m_strTradeTime || row.time || "");
  return `o:${oid}:${t}:${dealPrice(row)}:${num(row.m_nVolume || row.qty)}`;
}

function isUsableState(data) {
  if (!data || data.updatedAt == null) return false;
  if (String(data.source || "") === "sim" || String(data.account || "") === "SIM") return false;
  return num(data.bid1) > 0 || num(data.ask1) > 0;
}

function pendingHangRequests(data) {
  return ((data && data.pendingHangs) || []).filter((row) => {
    const st = String(row.status || "pending").toLowerCase();
    return st === "pending" || st === "claimed";
  });
}

function liveHangQtyMaps(data) {
  const buy = new Map();
  const sell = new Map();
  for (const row of orderRows(data)) {
    const side = optSide(row) || "buy";
    const remaining = num(row.m_nVolumeTotal);
    if (!OPEN_STATUS.has(statusCode(row)) || !(remaining > 0)) continue;
    const idx = priceToIdx(orderPrice(row));
    const map = side === "sell" ? sell : buy;
    map.set(idx, (map.get(idx) || 0) + remaining);
  }
  return { buy, sell };
}

function hangMapsWithPending(data) {
  const { buy, sell } = liveHangQtyMaps(data);
  for (const row of pendingHangRequests(data)) {
    const idx = priceToIdx(num(row.price));
    const map = row.side === "sell" ? sell : buy;
    map.set(idx, (map.get(idx) || 0) + num(row.qty));
  }
  return { buy, sell };
}

function cruiseEnableError(data, profile) {
  if (!data || !isUsableState(data)) return "暂无行情与挂单，禁止巡航";
  const pending = pendingHangRequests(data);
  if (pending.length) {
    const buys = pending.filter((x) => x.side === "buy").length;
    const sells = pending.filter((x) => x.side === "sell").length;
    return `有待执行的买挂或卖挂（买挂 ${buys} / 卖挂 ${sells}），禁止巡航`;
  }
  const { buy, sell } = liveHangQtyMaps(data);
  if (!sell.size) return "没有卖挂，无法确定巡航点，禁止巡航";
  const sellCruise = Math.min(...sell.keys());
  if (buy.size) {
    const buyHigh = Math.max(...buy.keys());
    const spreadTicks = sellCruise - buyHigh;
    const needTicks = Math.round(profile.minSpread * SCALE);
    if (spreadTicks < needTicks) {
      return `最高买挂与卖挂价差 ${(spreadTicks / SCALE).toFixed(3)} < ${profile.minSpread.toFixed(3)}，禁止巡航`;
    }
  }
  return "";
}

function cruiseAnchorIdx(data, maps, profile) {
  const { buy, sell } = maps;
  const gapTicks = Math.round(profile.minSpread * SCALE);
  const bidIdx = num(data.bid1) > 0 ? priceToIdx(data.bid1) : 0;
  const askIdx = num(data.ask1) > 0 ? priceToIdx(data.ask1) : 0;
  let sellCruise = sell.size ? Math.min(...sell.keys()) : 0;
  if (!sellCruise && askIdx > 0) sellCruise = askIdx;
  let buyCruise = sellCruise ? sellCruise - gapTicks : 0;
  if (bidIdx > 0) buyCruise = buyCruise ? Math.min(buyCruise, bidIdx) : bidIdx;
  return { buy, sell, buyCruise, sellCruise };
}

function cruiseFillPlans(ctx, sides) {
  const { data, profile, qty } = ctx;
  const maps = hangMapsWithPending(data);
  const { buy, sell, buyCruise, sellCruise } = cruiseAnchorIdx(data, maps, profile);
  const want = new Set(sides || ["buy", "sell"]);
  const plans = [];
  function addSide(side, startIdx, dir, have) {
    if (!(startIdx > 0)) return;
    for (let i = 0; i < profile.levels; i++) {
      const idx = startIdx + dir * i;
      const need = qty - (have.get(idx) || 0);
      if (need <= 0) continue;
      const q = Math.floor(need / 100) * 100;
      if (q > 0) plans.push({ side, price: idxToPrice(idx), qty: q, coverQty: qty });
    }
  }
  if (want.has("buy")) addSide("buy", buyCruise, -stepTicks(profile.buyStep), buy);
  if (want.has("sell")) addSide("sell", sellCruise, stepTicks(profile.sellStep), sell);
  return plans;
}

function cruiseBasePrice(data, row) {
  const oid = orderRowId(row);
  if (oid) {
    for (const order of orderRows(data)) {
      if (orderRowId(order) === oid) {
        const px = orderPrice(order);
        if (px > 0) return px;
      }
    }
  }
  return dealPrice(row);
}

function dealTimeRank(row) {
  const dateDigits = String(row.m_strTradeDate || row.date || "").replace(/\D/g, "");
  const raw = String(row.m_strTradeTime || row.time || row.m_strInsertTime || row.m_strTime || "").trim();
  const digits = raw.replace(/\D/g, "");
  if (digits.length >= 6) {
    const hh = Number(digits.slice(0, 2)) || 0;
    const mm = Number(digits.slice(2, 4)) || 0;
    const ss = Number(digits.slice(4, 6)) || 0;
    const ms = digits.length > 6 ? Number(digits.slice(6).padEnd(3, "0").slice(0, 3)) || 0 : 0;
    const day = dateDigits.length >= 8 ? Number(dateDigits.slice(0, 8)) || 0 : 0;
    return day * 1e10 + hh * 1e8 + mm * 1e6 + ss * 1e3 + ms;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function compareCruiseDeals(data, a, b) {
  const ta = dealTimeRank(a);
  const tb = dealTimeRank(b);
  if (ta !== tb) return ta - tb;
  const sa = optSide(a);
  const sb = optSide(b);
  if (sa !== sb) {
    if (sa === "sell") return -1;
    if (sb === "sell") return 1;
  }
  const pa = cruiseBasePrice(data, a);
  const pb = cruiseBasePrice(data, b);
  return sa === "sell" ? pa - pb : pb - pa;
}

function clampCruiseHangPx(side, px, data) {
  let out = roundTickPx(px);
  const bid = num(data && data.bid1);
  const ask = num(data && data.ask1);
  if (side === "buy" && bid > 0 && out > bid + 1e-9) out = roundTickPx(bid);
  if (side === "sell" && ask > 0 && out < ask - 1e-9) out = roundTickPx(ask);
  return out;
}

function isRetryableHangError(message) {
  const s = String(message || "");
  return s.includes("买1") || s.includes("卖1");
}

function liveOpenRungs(data, dropped) {
  const out = [];
  for (const row of orderRows(data)) {
    const side = optSide(row);
    if (side !== "buy" && side !== "sell") continue;
    const remaining = num(row.m_nVolumeTotal);
    if (!OPEN_STATUS.has(statusCode(row)) || !(remaining > 0)) continue;
    const orderId = orderRowId(row);
    if (orderId && dropped.has(orderId)) continue;
    const qty = Math.floor(remaining / 100) * 100;
    const price = roundTickPx(orderPrice(row));
    if (!(price > 0) || !(qty > 0)) continue;
    out.push({ side, price, qty, orderId });
  }
  return out;
}

function bookSignature(book) {
  const body = (book.rungs || []).map((r) => `${r.side}:${r.price}:${r.qty}:${r.orderId || ""}`).join("|");
  const drop = [...(book.dropped || [])].map(String).sort().join(",");
  const deal = (row) => (row ? `${row.side}:${row.price}:${row.date}:${row.rank}` : "");
  return `${body}#${drop}#${deal(book.lastDeal)}#${deal(book.prevDeal)}`;
}

function resumeCruisePlans(ctx) {
  const { data, book } = ctx;
  const saved = book.rungs || [];
  if (!saved.length || !Array.isArray(data.orders)) return [];
  const covered = hangMapsWithPending(data);
  const byId = new Map();
  for (const row of data.orders) {
    const id = orderRowId(row);
    if (id) byId.set(id, row);
  }
  const anyStillOpen = saved.some((rung) => {
    const row = byId.get(rung.orderId);
    return row && OPEN_STATUS.has(statusCode(row)) && num(row.m_nVolumeTotal) > 0;
  });
  const askIdx = num(data.ask1) > 0 ? priceToIdx(data.ask1) : 0;
  const bidIdx = num(data.bid1) > 0 ? priceToIdx(data.bid1) : 0;
  const plans = [];
  for (const rung of saved) {
    if (rung.orderId && book.dropped.has(rung.orderId)) continue;
    const idx = priceToIdx(rung.price);
    const have = (rung.side === "sell" ? covered.sell : covered.buy).get(idx) || 0;
    if (have >= rung.qty) continue;
    const row = rung.orderId ? byId.get(rung.orderId) : null;
    if (row && OPEN_STATUS.has(statusCode(row)) && num(row.m_nVolumeTotal) > 0) continue;
    if (row && statusCode(row) === 56) continue;
    const cancelled = row && CANCEL_STATUS.has(statusCode(row));
    const rolledOff = !row && !anyStillOpen;
    if (!cancelled && !rolledOff) continue;
    if (rung.side === "sell" && askIdx > 0 && idx < askIdx) continue;
    if (rung.side === "buy" && bidIdx > 0 && idx > bidIdx) continue;
    const qty = Math.floor((rung.qty - have) / 100) * 100;
    if (qty > 0) plans.push({ side: rung.side, price: rung.price, qty, coverQty: rung.qty });
  }
  return plans;
}

function cruiseLadderIdxs(ctx, side) {
  const { data, book } = ctx;
  const maps = hangMapsWithPending(data);
  const live = side === "sell" ? maps.sell : maps.buy;
  if (live.size) return [...live.keys()];
  const idxs = [];
  for (const rung of book.rungs || []) {
    if (rung.side !== side) continue;
    if (rung.orderId && book.dropped.has(rung.orderId)) continue;
    const idx = priceToIdx(rung.price);
    if (idx > 0) idxs.push(idx);
  }
  return idxs;
}

function cruiseGapPlans(ctx) {
  const { data, mem, profile, qty } = ctx;
  const maps = hangMapsWithPending(data);
  const buyStep = stepTicks(profile.buyStep);
  const sellStep = stepTicks(profile.sellStep);
  const levels = profile.levels;
  const askIdx = num(data.ask1) > 0 ? priceToIdx(data.ask1) : 0;
  const bidIdx = num(data.bid1) > 0 ? priceToIdx(data.bid1) : 0;
  const plans = [];
  const push = (side, idx, have) => {
    const q = Math.floor((qty - (have.get(idx) || 0)) / 100) * 100;
    if (q > 0) plans.push({ side, price: idxToPrice(idx), qty: q, coverQty: qty });
  };

  const sellIdxs = cruiseLadderIdxs(ctx, "sell");
  const sellHigh = sellIdxs.length ? Math.max(...sellIdxs) : 0;
  if (askIdx > 0 && sellHigh > 0 && askIdx > sellHigh) {
    mem.sellGapFrom = askIdx;
    mem.sellGapTop = askIdx + levels * sellStep;
  } else if (mem.sellGapFrom && askIdx > mem.sellGapFrom) {
    mem.sellGapFrom = askIdx;
    mem.sellGapTop = askIdx + levels * sellStep;
  }
  if (mem.sellGapFrom && mem.sellGapTop) {
    const before = plans.length;
    for (let idx = mem.sellGapFrom; idx <= mem.sellGapTop; idx += sellStep) push("sell", idx, maps.sell);
    if (plans.length === before) {
      mem.sellGapFrom = 0;
      mem.sellGapTop = 0;
    } else {
      const sig = `sell:${mem.sellGapFrom}:${mem.sellGapTop}`;
      if (mem.gapNoteSell !== sig) {
        mem.gapNoteSell = sig;
        const fromPx = idxToPrice(mem.sellGapFrom).toFixed(3);
        ctx.alert(`卖一 ${fromPx} 击穿卖挂，卖挂从 ${fromPx} 补到 ${idxToPrice(mem.sellGapTop).toFixed(3)}`);
      }
    }
  }

  const buyIdxs = cruiseLadderIdxs(ctx, "buy");
  const buyLow = buyIdxs.length ? Math.min(...buyIdxs) : 0;
  if (bidIdx > 0 && buyLow > 0 && bidIdx < buyLow) {
    mem.buyGapFrom = bidIdx;
    mem.buyGapLow = bidIdx - levels * buyStep;
  } else if (mem.buyGapFrom && bidIdx > 0 && bidIdx < mem.buyGapFrom) {
    mem.buyGapFrom = bidIdx;
    mem.buyGapLow = bidIdx - levels * buyStep;
  }
  if (mem.buyGapFrom && mem.buyGapLow) {
    const before = plans.length;
    for (let idx = mem.buyGapFrom; idx >= mem.buyGapLow && idx > 0; idx -= buyStep) push("buy", idx, maps.buy);
    if (plans.length === before) {
      mem.buyGapFrom = 0;
      mem.buyGapLow = 0;
    } else {
      const sig = `buy:${mem.buyGapFrom}:${mem.buyGapLow}`;
      if (mem.gapNoteBuy !== sig) {
        mem.gapNoteBuy = sig;
        const fromPx = idxToPrice(mem.buyGapFrom).toFixed(3);
        ctx.alert(`买一 ${fromPx} 击穿买挂，买挂从 ${fromPx} 补到 ${idxToPrice(mem.buyGapLow).toFixed(3)}`);
      }
    }
  }
  return plans;
}

function shanghaiTodayDigits() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date()).replace(/\D/g, "");
}

function dealDateDigits(row) {
  const raw = String((row && (row.m_strTradeDate || row.date || row.m_strInsertDate)) || "").replace(/\D/g, "");
  return raw.length >= 8 ? raw.slice(0, 8) : "";
}

function normalizeSavedDeal(raw) {
  if (!raw || (raw.side !== "buy" && raw.side !== "sell")) return null;
  const price = roundTickPx(raw.price);
  const date = String(raw.date || "").replace(/\D/g, "").slice(0, 8);
  if (!(price > 0) || date.length < 8) return null;
  return { side: raw.side, price, date, rank: num(raw.rank) };
}

function rememberSessionDeals(ctx) {
  const { data, book } = ctx;
  const rows = [];
  for (const row of data.deals || []) {
    const side = optSide(row);
    const price = roundTickPx(dealPrice(row));
    const date = dealDateDigits(row);
    if ((side !== "buy" && side !== "sell") || !(price > 0) || !date) continue;
    rows.push({ side, price, date, rank: dealTimeRank(row) });
  }
  if (!rows.length) return;
  let latest = book.lastDeal;
  let prev = book.prevDeal;
  rows.sort((a, b) => a.rank - b.rank);
  for (const deal of rows) {
    if (latest && deal.date > latest.date) prev = latest;
    if (!latest || deal.rank > latest.rank) latest = deal;
  }
  if (latest) {
    for (const deal of rows) {
      if (deal.date < latest.date && (!prev || deal.rank > prev.rank)) prev = deal;
    }
  }
  book.lastDeal = latest;
  book.prevDeal = prev;
}

function yesterdayLastDeal(ctx) {
  const { data, book } = ctx;
  const today = shanghaiTodayDigits();
  let best = null;
  for (const row of data.deals || []) {
    const date = dealDateDigits(row);
    const side = optSide(row);
    const price = roundTickPx(dealPrice(row));
    if (!date || date >= today || (side !== "buy" && side !== "sell") || !(price > 0)) continue;
    const rank = dealTimeRank(row);
    if (!best || rank > best.rank) best = { side, price, date, rank };
  }
  if (best) return best;
  if (book.prevDeal && book.prevDeal.date < today) return book.prevDeal;
  if (book.lastDeal && book.lastDeal.date < today) return book.lastDeal;
  return null;
}

function seedCruisePlans(ctx) {
  const { data, book, mem, profile, qty } = ctx;
  if ((book.rungs || []).length) return [];
  if (liveOpenRungs(data, book.dropped).length) return [];
  const deal = yesterdayLastDeal(ctx);
  if (!deal) return [];
  const step = deal.side === "sell" ? profile.sellStep : profile.reverseGap;
  const sellPx = roundTickPx(deal.price + step);
  const sellIdx = priceToIdx(sellPx);
  if (!(sellIdx > 0)) return [];
  const buyIdx = sellIdx - Math.round(profile.minSpread * SCALE);
  const covered = hangMapsWithPending(data);
  const plans = [];
  function add(side, start, dir, have) {
    if (!(start > 0)) return;
    for (let i = 0; i < profile.levels; i += 1) {
      const idx = start + dir * i;
      const q = Math.floor((qty - (have.get(idx) || 0)) / 100) * 100;
      if (q > 0) plans.push({ side, price: idxToPrice(idx), qty: q, coverQty: qty });
    }
  }
  add("sell", sellIdx, stepTicks(profile.sellStep), covered.sell);
  add("buy", buyIdx, -stepTicks(profile.buyStep), covered.buy);
  const note = `${deal.date}:${deal.side}:${deal.price}`;
  if (plans.length && mem.seedNote !== note) {
    mem.seedNote = note;
    const verb = deal.side === "sell" ? "卖成" : "买成";
    ctx.alert(`无续航档位，按昨日最后一笔${verb} ${deal.price.toFixed(3)}，卖挂从 ${sellPx.toFixed(3)} 开始`);
  }
  return plans;
}

function cruiseReversePlan(ctx, row) {
  const { data, profile } = ctx;
  const side = optSide(row);
  if (side !== "buy" && side !== "sell") return null;
  const basePx = cruiseBasePrice(data, row);
  const qty = Math.round(num(row.m_nVolume || row.qty));
  if (!(basePx > 0) || !(qty > 0)) return null;
  const nextSide = side === "sell" ? "buy" : "sell";
  const rawPx = roundTickPx(basePx + (side === "sell" ? -profile.reverseGap : profile.reverseGap));
  const price = clampCruiseHangPx(nextSide, rawPx, data);
  return { side: nextSide, price, qty, rawPx };
}

// ---------------------------------------------------------------------------------------------

const mems = new Map();
function memFor(username, stock) {
  const key = `${username}|${stock}`;
  if (!mems.has(key)) {
    mems.set(key, { sellGapFrom: 0, sellGapTop: 0, buyGapFrom: 0, buyGapLow: 0, gapNoteSell: "", gapNoteBuy: "", seedNote: "" });
  }
  return mems.get(key);
}

function log(level, stock, username, message) {
  const text = `${stock} ${message}`;
  if (level === "error") console.error(`[cruise] ${text}`);
  else console.log(`[cruise] ${text}`);
  db.appendDebug([{ level, message: text }], { source: "cruise", runId: String(username || "").slice(0, 32) })
    .catch((err) => console.error("cruise log failed:", err.message));
}

function makeCtx({ username, stock, data, state, qty }) {
  const profile = profileOf(stock);
  const ctx = {
    username,
    stock,
    data,
    profile,
    qty: snapQty(qty || state.qty || inferRungQty(state.rungs), profile),
    mem: memFor(username, stock),
    book: {
      rungs: Array.isArray(state.rungs) ? state.rungs : [],
      dropped: new Set((state.dropped || []).map(String)),
      lastDeal: normalizeSavedDeal(state.lastDeal),
      prevDeal: normalizeSavedDeal(state.prevDeal),
      seenDeals: new Set((state.seenDeals || []).map(String)),
      seenFails: new Set((state.seenFails || []).map(String)),
    },
  };
  ctx.alert = (message) => log("warn", stock, username, message);
  ctx.info = (message) => log("info", stock, username, message);
  ctx.fail = (message) => log("error", stock, username, message);
  return ctx;
}

async function placePlan(ctx, plan, reason, level = "info") {
  const label = plan.side === "sell" ? "卖挂" : "买挂";
  const order = await db.createHangOrder({
    account: ctx.data.account,
    stock: ctx.stock,
    side: plan.side,
    price: plan.price,
    qty: plan.qty,
    source: "cruise",
    coverQty: plan.coverQty || 0,
  });
  if (!order || order.covered) return { covered: true };
  ctx.data.pendingHangs = (ctx.data.pendingHangs || []).concat({
    id: order.id, side: order.side, price: Number(order.price), qty: Number(order.qty), status: "pending", source: "cruise",
  });
  log(level, ctx.stock, ctx.username, `${reason} ${label} ${Number(order.price).toFixed(3)} × ${order.qty} #${order.id}`);
  return order;
}

async function placePlans(ctx, plans, reason) {
  for (const plan of plans) {
    const lease = await db.renewCruiseLease(ctx.username, "live", ctx.stock, HOLDER);
    if (!lease.held) return false;
    const label = plan.side === "sell" ? "卖挂" : "买挂";
    try {
      await placePlan(ctx, plan, reason);
    } catch (err) {
      ctx.fail(`${reason}失败：${label} ${plan.price.toFixed(3)} × ${plan.qty}：${err.message}`);
    }
  }
  return true;
}

async function noteFails(ctx) {
  const fails = await db.listFailedHangs({ stock: ctx.stock });
  for (const row of fails) {
    if (row.source !== "cruise") continue;
    const id = String(row.id);
    if (ctx.book.seenFails.has(id)) continue;
    ctx.book.seenFails.add(id);
    const claimed = await db.claimCruiseSeen(ctx.username, "live", "fail", id, ctx.stock);
    if (!claimed.claimed) continue;
    const label = row.side === "sell" ? "卖挂" : "买挂";
    ctx.fail(`${label}执行失败 ${Number(row.price).toFixed(3)} × ${row.qty}：${row.errorMessage || "执行失败"}`);
  }
}

async function tickOne({ username, stock, qty }) {
  const profile = profileOf(stock);
  if (!profile) return;
  const lease = await db.renewCruiseLease(username, "live", stock, HOLDER);
  if (!lease.held) return;
  const data = await db.getSnapshot(0, stock);
  if (!isUsableState(data)) return;
  const state = await db.getCruiseState(username, "live", stock);
  if (!state.on) return;
  const ctx = makeCtx({ username, stock, data, state, qty });
  const { book } = ctx;
  const sigBefore = bookSignature(book);

  rememberSessionDeals(ctx);
  await noteFails(ctx);
  const live = liveOpenRungs(data, book.dropped);
  if (live.length) book.rungs = live;

  const resumePlans = resumeCruisePlans(ctx);
  const seedPlans = resumePlans.length ? [] : seedCruisePlans(ctx);
  const fresh = [];
  for (const row of data.deals || []) {
    const key = dealKey(row);
    if (!key || book.seenDeals.has(key)) continue;
    fresh.push({ row, key });
  }
  fresh.sort((a, b) => compareCruiseDeals(data, a.row, b.row));
  const buyTopUp = cruiseFillPlans(ctx, ["buy"]);
  const gapPlans = cruiseGapPlans(ctx);

  if (fresh.length || buyTopUp.length || resumePlans.length || seedPlans.length || gapPlans.length) {
    const merged = new Map();
    for (const { row, key } of fresh) {
      const claimed = await db.claimCruiseSeen(username, "live", "deal", key, stock);
      book.seenDeals.add(key);
      if (!claimed.claimed) continue;
      const plan = cruiseReversePlan(ctx, row);
      if (!plan) continue;
      const slot = `${plan.side}:${priceToIdx(plan.price)}`;
      const cur = merged.get(slot);
      if (cur) {
        cur.qty += plan.qty;
        cur.keys.push(key);
      } else {
        merged.set(slot, { ...plan, keys: [key], dealPx: dealPrice(row), dealSide: optSide(row) });
      }
    }

    let held = true;
    for (const plan of merged.values()) {
      const q = Math.floor(plan.qty / 100) * 100;
      if (!(q > 0)) continue;
      const still = await db.renewCruiseLease(username, "live", stock, HOLDER);
      if (!still.held) {
        held = false;
        for (const key of plan.keys) await db.unclaimCruiseSeen(username, "live", "deal", key, stock);
        continue;
      }
      const label = plan.side === "sell" ? "卖挂" : "买挂";
      const verb = plan.dealSide === "sell" ? "卖成" : "买成";
      const clamped = Math.abs(plan.rawPx - plan.price) > 1e-9 ? `（目标 ${plan.rawPx.toFixed(3)} 已越过，按${plan.side === "buy" ? "买一" : "卖一"}挂）` : "";
      try {
        await placePlan(ctx, { side: plan.side, price: plan.price, qty: q }, `${verb} ${plan.dealPx.toFixed(3)} 反挂${clamped}`, clamped ? "warn" : "info");
      } catch (err) {
        ctx.fail(`${label}失败 ${plan.price.toFixed(3)} × ${q}：${err.message}`);
        if (isRetryableHangError(err.message)) {
          for (const key of plan.keys) await db.unclaimCruiseSeen(username, "live", "deal", key, stock);
        }
      }
    }

    if (held && gapPlans.length) held = await placePlans(ctx, gapPlans, "跳空补档");
    if (held && resumePlans.length) held = await placePlans(ctx, resumePlans, "跨天续航");
    if (held && seedPlans.length) held = await placePlans(ctx, seedPlans, "按昨日成交续航");
    if (held && !(book.rungs.length && !liveOpenRungs(data, book.dropped).length)) {
      const { sell } = hangMapsWithPending(data);
      const plans = cruiseFillPlans(ctx, ["buy"]);
      if (!sell.size) plans.push(...cruiseFillPlans(ctx, ["sell"]));
      if (plans.length) await placePlans(ctx, plans, "补档");
    }
  }

  if (bookSignature(book) !== sigBefore) await db.saveCruiseBookIfOn(username, stock, book);
}

// Enable: validate against the latest snapshot, fill both ladders, then switch cruise on.
async function enableCruise(username, stock, qty) {
  const code = db.normalizeStockCode(stock);
  const profile = profileOf(code);
  if (!profile) return { ok: false, error: `不支持巡航的股票：${stock}` };
  const data = await db.getSnapshot(0, code);
  const reason = cruiseEnableError(data, profile);
  if (reason) return { ok: false, error: reason };
  const lease = await db.renewCruiseLease(username, "live", code, HOLDER);
  if (!lease.held && lease.reason === "busy") return { ok: false, error: "巡航正由另一个服务器实例执行，请稍后再试" };
  const ctx = makeCtx({ username, stock: code, data, state: { qty }, qty });
  for (const plan of cruiseFillPlans(ctx)) {
    const label = plan.side === "sell" ? "卖挂" : "买挂";
    try {
      await placePlan(ctx, plan, "开启巡航补齐");
    } catch (err) {
      const error = `巡航补单失败：${label} ${plan.price.toFixed(3)} × ${plan.qty}：${err.message}`;
      ctx.fail(error);
      return { ok: false, error };
    }
  }
  const state = await db.setCruiseState(username, "live", true, code, ctx.qty);
  await db.renewCruiseLease(username, "live", code, HOLDER);
  ctx.info(`开启巡航 数量 ${ctx.qty}`);
  return { ok: true, state };
}

async function disableCruise(username, stock) {
  const code = db.normalizeStockCode(stock);
  const state = await db.setCruiseState(username, "live", false, code);
  mems.delete(`${username}|${code}`);
  log("info", code, username, "退出巡航");
  return { ok: true, state };
}

let timer = null;
let running = false;

async function tickAll() {
  if (running) return;
  running = true;
  try {
    const rows = await db.listActiveCruises();
    for (const row of rows) {
      try {
        await tickOne(row);
      } catch (err) {
        log("error", row.stock, row.username, `巡航异常：${err.stack || err.message}`);
      }
    }
  } catch (err) {
    console.error("[cruise] tickAll failed:", err.message);
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  console.log(`[cruise] engine started holder=${HOLDER} every ${TICK_MS}ms`);
  timer = setInterval(() => {
    tickAll().catch(() => {});
  }, TICK_MS);
  tickAll().catch(() => {});
}

async function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  try {
    for (const row of await db.listActiveCruises()) {
      await db.releaseCruiseLease(row.username, "live", row.stock, HOLDER);
    }
  } catch (_err) {}
}

module.exports = { start, stop, tickAll, tickOne, enableCruise, disableCruise, HOLDER, _test: { cruiseEnableError, cruiseFillPlans, makeCtx } };
