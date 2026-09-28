#!/usr/bin/env node
// Exercises server/cruise.js against an in-memory fake of server/db.js. No network, no MySQL.
const path = require("path");
const assert = require("assert");

function makeFakeDb() {
  const state = {
    snapshot: null,
    cruise: { on: false, qty: 0, rungs: [], dropped: [], lastDeal: null, prevDeal: null, seenDeals: [], seenFails: [] },
    pending: [],
    failed: [],
    seen: new Set(),
    leaseHolder: null,
    leaseBusy: false,
    placed: [],
    logs: [],
    nextId: 1000,
    rejectBuyAbove: null,
  };
  const fake = {
    state,
    normalizeStockCode: (s) => {
      const short = String(s || "").toUpperCase().replace(/\.(SZ|SH)$/, "");
      return short === "516310" ? "516310.SH" : "159781.SZ";
    },
    async getSnapshot() {
      return { ...state.snapshot, pendingHangs: state.pending.slice(), orders: state.snapshot.orders.slice() };
    },
    async getCruiseState() {
      return { ...state.cruise, seenDeals: [...state.seen].filter((k) => k.startsWith("deal|")).map((k) => k.slice(5)), seenFails: [] };
    },
    async setCruiseState(_u, _c, on, _s, qty) {
      state.cruise.on = on;
      if (qty) state.cruise.qty = qty;
      if (on) for (const d of state.snapshot.deals) state.seen.add(`deal|t:${d.m_strTradeID}`);
      return { on, qty: state.cruise.qty };
    },
    async listActiveCruises() {
      return state.cruise.on ? [{ username: "u", stock: "159781.SZ", qty: state.cruise.qty }] : [];
    },
    async saveCruiseBookIfOn(_u, _s, book) {
      state.cruise.rungs = book.rungs;
      state.cruise.dropped = [...book.dropped];
      state.cruise.lastDeal = book.lastDeal;
      state.cruise.prevDeal = book.prevDeal;
      return true;
    },
    async renewCruiseLease(_u, _c, _s, holder) {
      if (state.leaseBusy) return { held: false, reason: "busy" };
      state.leaseHolder = holder;
      return { held: true };
    },
    async releaseCruiseLease() { return { ok: true }; },
    async claimCruiseSeen(_u, _c, kind, key) {
      const k = `${kind}|${key}`;
      if (state.seen.has(k)) return { claimed: false };
      state.seen.add(k);
      return { claimed: true };
    },
    async unclaimCruiseSeen(_u, _c, kind, key) {
      state.seen.delete(`${kind}|${key}`);
      return { ok: true };
    },
    async listFailedHangs() { return state.failed; },
    async createHangOrder({ side, price, qty, coverQty }) {
      if (side === "buy" && state.rejectBuyAbove != null && price > state.rejectBuyAbove) {
        throw new Error(`买挂只能在买1及下方（买1=${state.rejectBuyAbove}）`);
      }
      if (coverQty) {
        const px = Math.round(price * 1000);
        const have = state.pending.filter((p) => p.side === side && Math.round(p.price * 1000) === px).reduce((a, p) => a + p.qty, 0);
        if (have >= coverQty) return { covered: true };
      }
      const order = { id: state.nextId++, side, price, qty, status: "pending" };
      state.pending.push(order);
      state.placed.push(order);
      return order;
    },
    async appendDebug(lines, meta) {
      for (const l of lines) state.logs.push(`${l.level} ${l.message}`);
      return { accepted: lines.length, meta };
    },
  };
  return fake;
}

const fake = makeFakeDb();
require.cache[path.resolve(__dirname, "../server/db.js")] = {
  id: "db", filename: "db", loaded: true, exports: fake,
};
const cruise = require("../server/cruise");

function order(side, price, qty, status, id) {
  return { m_strOptName: side === "sell" ? "限价卖出" : "限价买入", m_dLimitPrice: price, m_nVolumeTotal: qty, m_nVolumeTotalOriginal: qty, m_nOrderStatus: status, m_strOrderSysID: String(id) };
}
function deal(side, price, qty, tradeId, orderId, time) {
  return { m_strOptName: side === "sell" ? "限价卖出" : "限价买入", m_dPrice: price, m_nVolume: qty, m_strTradeID: tradeId, m_strOrderSysID: String(orderId), m_strTradeTime: time, m_strTradeDate: "20260928" };
}
const summary = (list) => list.map((o) => `${o.side}@${o.price.toFixed(3)}x${o.qty}`).join(" ");

(async () => {
  const s = fake.state;
  console.log(`holder=${cruise.HOLDER}`);

  // 1. enable: one sell hang at 1.001, bid/ask 0.994/0.995 -> fills 10 sells up from 1.001, 10 buys down from 0.989
  s.snapshot = { account: "A", stock: "159781.SZ", updatedAt: 1, bid1: 0.994, ask1: 0.995, orders: [order("sell", 1.001, 5000, 50, 1)], deals: [] };
  let out = await cruise.enableCruise("u", "159781.SZ", 5000);
  assert.ok(out.ok, out.error);
  const sells = s.placed.filter((o) => o.side === "sell");
  const buys = s.placed.filter((o) => o.side === "buy");
  assert.strictEqual(sells.length, 9, "9 more sells (1.001 already has 5000)");
  assert.strictEqual(sells[0].price, 1.002);
  assert.strictEqual(buys.length, 10);
  assert.strictEqual(buys[0].price, 0.989);
  assert.strictEqual(s.cruise.on, true);
  console.log("1 enable ok:", sells.length, "sells from", sells[0].price, "|", buys.length, "buys from", buys[0].price);

  // 2. enable is rejected while hangs are still pending
  out = await cruise.enableCruise("u", "159781.SZ", 5000);
  assert.ok(!out.ok && out.error.includes("待执行"));
  console.log("2 enable rejected:", out.error);

  // QMT picks the pending hangs up; they now appear as live orders
  let oid = 100;
  s.snapshot.orders = s.snapshot.orders.concat(s.pending.map((p) => order(p.side, p.price, p.qty, 50, oid++)));
  s.pending = [];
  s.placed = [];

  // 3. a sell at 1.001 fills; bid still 0.994 -> reverse buy at 1.001 - 0.011 = 0.990
  s.snapshot.orders[0] = order("sell", 1.001, 0, 56, 1);
  s.snapshot.deals = [deal("sell", 1.001, 5000, "T1", 1, "100000")];
  await cruise.tickAll();
  assert.ok(s.placed.some((o) => o.side === "buy" && o.price === 0.99 && o.qty === 5000), summary(s.placed));
  console.log("3 reverse ok:", summary(s.placed));

  // 4. same deal again -> nothing new (already seen)
  s.placed = [];
  await cruise.tickAll();
  assert.strictEqual(s.placed.filter((o) => o.price === 0.99).length, 0);
  console.log("4 dedupe ok");

  // 5. stale reverse: sell at 1.002 fills but bid has dropped to 0.987 -> clamped to 0.987 (user's choice)
  s.snapshot.bid1 = 0.987;
  s.snapshot.ask1 = 0.988;
  s.snapshot.deals.push(deal("sell", 1.002, 5000, "T2", 110, "100500"));
  s.placed = [];
  await cruise.tickAll();
  const clamped = s.placed.find((o) => o.side === "buy" && o.qty === 5000 && o.price === 0.987);
  assert.ok(clamped, summary(s.placed));
  assert.ok(s.logs.some((l) => l.includes("目标 0.991 已越过")), "clamp is logged");
  console.log("5 clamp ok:", summary(s.placed));

  // 6. lease held elsewhere -> no orders
  s.leaseBusy = true;
  s.snapshot.deals.push(deal("sell", 1.003, 5000, "T3", 111, "100600"));
  s.placed = [];
  await cruise.tickAll();
  assert.strictEqual(s.placed.length, 0);
  assert.ok(!s.seen.has("deal|t:T3"), "deal not consumed without lease");
  s.leaseBusy = false;
  console.log("6 lease busy ok");

  // 7. retryable reject -> deal key is released for the next tick
  s.rejectBuyAbove = 0.9;
  s.placed = [];
  await cruise.tickAll();
  assert.ok(!s.seen.has("deal|t:T3"), "retryable failure unclaims");
  s.rejectBuyAbove = null;
  await cruise.tickAll();
  assert.ok(s.placed.some((o) => o.side === "buy" && o.price === 0.987), summary(s.placed));
  console.log("7 retry ok:", summary(s.placed));

  // 8. sim snapshot is ignored
  s.snapshot.source = "sim";
  s.snapshot.deals.push(deal("sell", 1.004, 5000, "T4", 112, "100700"));
  s.placed = [];
  await cruise.tickAll();
  assert.strictEqual(s.placed.length, 0);
  delete s.snapshot.source;
  console.log("8 sim ignored ok");

  // 9. disable -> engine stops acting
  await cruise.disableCruise("u", "159781.SZ");
  s.placed = [];
  await cruise.tickAll();
  assert.strictEqual(s.placed.length, 0);
  console.log("9 disable ok");

  console.log("\nlast engine logs:\n  " + s.logs.slice(-6).join("\n  "));
  console.log("\nALL PASSED");
})().catch((err) => {
  console.error("FAILED:", err.stack || err.message);
  process.exit(1);
});
