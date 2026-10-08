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
      return { ...state.snapshot, pendingHangs: state.pending.slice(), landingHangs: (state.landing || []).slice(), orders: state.snapshot.orders.slice() };
    },
    async getCruiseState() {
      return { ...state.cruise, seenDeals: [...state.seen].filter((k) => k.startsWith("deal|")).map((k) => k.slice(5)), seenFails: [] };
    },
    async setCruiseGrid(_u, _s, grid) {
      if (state.cruise.on) return { ok: false, locked: true, error: "巡航已开启，不能修改步长和价差" };
      state.cruise.step = grid.step;
      state.cruise.reverseGap = grid.reverseGap;
      state.cruise.minSpread = grid.minSpread;
      return { ok: true, state: { ...state.cruise } };
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
    async createCancelOrder({ targetOrderId, price, qty }) {
      const row = { id: state.nextId++, action: "cancel", targetOrderId, price, qty };
      (state.cancels = state.cancels || []).push(row);
      return row;
    },
    async createHangOrder({ side, price, qty, coverQty }) {
      if (side === "buy" && state.rejectBuyAbove != null && price > state.rejectBuyAbove) {
        throw new Error(`买挂只能在买1及下方（买1=${state.rejectBuyAbove}）`);
      }
      if (coverQty) {
        const px = Math.round(price * 1000);
        const pendingQty = state.pending.filter((p) => p.side === side && Math.round(p.price * 1000) === px).reduce((a, p) => a + p.qty, 0);
        const liveQty = (state.snapshot.orders || []).reduce((sum, row) => {
          const name = String(row.m_strOptName || "");
          const rowSide = name.includes("卖") ? "sell" : "buy";
          const open = [48, 49, 50, 51, 52, 55].includes(row.m_nOrderStatus) && row.m_nVolumeTotal > 0;
          if (!open || rowSide !== side || Math.round(row.m_dLimitPrice * 1000) !== px) return sum;
          return sum + row.m_nVolumeTotal;
        }, 0);
        const room = Math.floor((coverQty - pendingQty - liveQty) / 100) * 100;
        if (!(room > 0)) return { covered: true };
        qty = Math.min(qty, room);
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

  // 5. sell at 1.002 fills and the clamped reverse lands on 0.987, which already has the cruise qty
  s.snapshot.bid1 = 0.987;
  s.snapshot.ask1 = 0.988;
  s.snapshot.deals.push(deal("sell", 1.002, 5000, "T2", 110, "100500"));
  s.placed = [];
  await cruise.tickAll();
  assert.ok(!s.placed.some((o) => o.side === "buy" && o.price === 0.987), `full level is not stacked: ${summary(s.placed)}`);
  console.log("5 no stack on a full level:", summary(s.placed));

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
  s.placed = [];
  await cruise.tickAll();
  assert.ok(s.seen.has("deal|t:T3"), "full level consumes the deal instead of retrying");
  assert.ok(!s.placed.some((o) => o.side === "buy" && o.price === 0.987), summary(s.placed));
  console.log("7 retry then covered ok:", summary(s.placed));

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

  // --- enable without any sell hang: anchor on the last deal ---
  const reset = (snap, last) => {
    s.snapshot = { account: "A", stock: "159781.SZ", updatedAt: 1, ...snap, lastDeal: last };
    s.pending = [];
    s.placed = [];
    s.cancels = [];
    s.seen = new Set();
    s.cruise = { on: false, qty: 0, rungs: [], dropped: [], lastDeal: null, prevDeal: null };
  };
  const prices = (side) => s.placed.filter((o) => o.side === side).map((o) => o.price.toFixed(3));

  // 10. last deal = sell 1.001 yesterday; live buys at 0.994 (violates spread) and 0.980
  reset({ bid1: 0.994, ask1: 0.995, orders: [order("buy", 0.994, 5000, 50, "B1"), order("buy", 0.98, 5000, 50, "B2")], deals: [] },
    { side: "sell", price: 1.001, qty: 5000, date: "20260926", time: "145200" });
  out = await cruise.enableCruise("u", "159781.SZ", 5000);
  assert.ok(out.ok, out.error);
  assert.deepStrictEqual(s.cancels.map((c) => c.targetOrderId), ["B1"], "cancel the buy above 0.990");
  assert.strictEqual(prices("sell")[0], "1.002");
  assert.strictEqual(prices("sell").length, 10);
  assert.strictEqual(prices("buy")[0], "0.990");
  assert.ok(!prices("buy").includes("0.994"), "no buy re-hung at the cancelled price");
  assert.ok(s.cruise.dropped.includes("B1"), "cancelled buy is marked dropped");
  assert.ok(out.note.includes("卖成 1.001") && out.note.includes("1.002") && out.note.includes("撤销 1 笔"), out.note);
  console.log("10 last sell ok:", out.note, "| sells", prices("sell")[0], "..", prices("sell").slice(-1)[0], "| buys", prices("buy")[0], "..", prices("buy").slice(-1)[0]);

  // 11. last deal = buy 0.987 today -> start at the paired sell 0.998
  reset({ bid1: 0.99, ask1: 0.991, orders: [], deals: [] }, { side: "buy", price: 0.987, qty: 5000, date: "20260928", time: "133925" });
  out = await cruise.enableCruise("u", "159781.SZ", 5000);
  assert.ok(out.ok, out.error);
  assert.strictEqual(prices("sell")[0], "0.998");
  assert.strictEqual(prices("buy")[0], "0.986");
  console.log("11 last buy ok:", out.note);

  // 12. anchor below ask -> lifted to ask
  reset({ bid1: 0.994, ask1: 0.995, orders: [], deals: [] }, { side: "sell", price: 0.99, qty: 5000, date: "20260928", time: "100000" });
  out = await cruise.enableCruise("u", "159781.SZ", 5000);
  assert.ok(out.ok, out.error);
  assert.strictEqual(prices("sell")[0], "0.995");
  assert.ok(out.note.includes("改从卖一开始"), out.note);
  console.log("12 lifted ok:", out.note);

  // 13. no sell hang and no last deal -> refused
  reset({ bid1: 0.994, ask1: 0.995, orders: [], deals: [] }, null);
  out = await cruise.enableCruise("u", "159781.SZ", 5000);
  assert.ok(!out.ok && out.error.includes("找不到当天或上一交易日的成交"), out.error);
  assert.strictEqual(s.placed.length, 0);
  console.log("13 no deal refused:", out.error);

  // 14. with a sell hang the old rule is unchanged: spread violation is refused, nothing cancelled
  reset({ bid1: 0.994, ask1: 0.995, orders: [order("sell", 1.0, 5000, 50, "S1"), order("buy", 0.994, 5000, 50, "B1")], deals: [] },
    { side: "sell", price: 1.001, qty: 5000, date: "20260928", time: "100000" });
  out = await cruise.enableCruise("u", "159781.SZ", 5000);
  assert.ok(!out.ok && out.error.includes("价差"), out.error);
  assert.strictEqual((s.cancels || []).length, 0);
  console.log("14 sell present unchanged:", out.error);

  const { pickLastDeal } = require("../server/deals");
  const picked = pickLastDeal([deal("buy", 0.987, 5000, "X1", 1, "133855"), deal("sell", 0.997, 2800, "X2", 2, "141033"), deal("buy", 1.037, 5000, "X3", 3, "92500")]);
  assert.strictEqual(picked.tradeId, "X2", "latest by time, 92500 is 09:25");
  console.log("15 pickLastDeal ok:", picked.side, picked.price, picked.time);

  const prevDay = deal("sell", 0.988, 1000, "Y", 9, "145500");
  prevDay.m_strTradeDate = "20261007";
  const thisMorning = deal("buy", 1.001, 1000, "T", 8, "92500");
  thisMorning.m_strTradeDate = "20261008";
  const latest = pickLastDeal([prevDay, thisMorning]);
  assert.strictEqual(latest.tradeId, "T", "morning fill on the current day outranks the previous afternoon");
  assert.strictEqual(latest.time, "092500");
  const undated = deal("buy", 1.002, 1000, "U", 7, "93015");
  undated.m_strTradeDate = "";
  const withSession = pickLastDeal([prevDay, undated], "20261008");
  assert.strictEqual(withSession.tradeId, "U", "a session deal without a date still counts as that day");
  console.log("15b current session outranks previous day");

  // 16. 09-30 13:13: buy 0.979 fills, reverse sell 0.990 is placed by QMT ('done') but the next
  // status push does not list it yet. The ladder must not re-anchor on 0.991 and re-buy 0.979.
  const ladderBuys = [0.978, 0.977, 0.976, 0.975, 0.974, 0.973, 0.972, 0.971, 0.97].map((p, i) => order("buy", p, 5000, 50, `LB${i}`));
  const ladderSells = [0.991, 0.992, 0.993, 0.994, 0.995, 0.996, 0.997, 0.998, 0.999, 1.0].map((p, i) => order("sell", p, 5000, 50, `LS${i}`));
  reset({ bid1: 0.979, ask1: 0.98, orders: [order("buy", 0.979, 0, 56, "B979"), ...ladderBuys, ...ladderSells], deals: [] }, null);
  s.cruise.on = true;
  s.cruise.qty = 5000;
  s.snapshot.deals = [deal("buy", 0.979, 5000, "D979", "B979", "131259")];
  s.snapshot.deals[0].m_strTradeDate = "20260930";
  await cruise.tickAll();
  assert.ok(s.placed.some((o) => o.side === "sell" && o.price === 0.99), summary(s.placed));
  assert.ok(!s.placed.some((o) => o.side === "buy" && o.price === 0.979), `pending reverse keeps the anchor: ${summary(s.placed)}`);
  s.landing = s.pending.map((p) => ({ ...p, status: "landing" }));
  s.pending = [];
  s.placed = [];
  await cruise.tickAll();
  assert.ok(!s.placed.some((o) => o.side === "buy" && o.price === 0.979), `landing reverse keeps the anchor: ${summary(s.placed)}`);
  s.landing = [];
  await cruise.tickAll();
  assert.ok(s.placed.some((o) => o.side === "buy" && o.price === 0.979), "without it the old bug re-buys 0.979");
  s.landing = [];
  console.log("16 landing reverse ok: no re-buy at 0.979 while the 0.990 sell is in flight");

  // 17. both stocks keep 买卖间距 one tick wider than 价差
  const grid = cruise._test.normalizeGrid("159781.SZ", { step: 0.002, gap: 0.02 });
  assert.deepStrictEqual({ step: grid.step, reverseGap: grid.reverseGap, minSpread: grid.minSpread }, { step: 0.002, reverseGap: 0.02, minSpread: 0.021 });
  const grid516 = cruise._test.normalizeGrid("516310.SH", { step: 0.001, gap: 0.008 });
  assert.strictEqual(grid516.minSpread, 0.009);
  assert.ok(cruise._test.normalizeGrid("159781.SZ", { step: 0.0015, gap: 0.011 }).error);
  s.cruise.on = false;
  let saved = await cruise.saveGrid("u", "159781.SZ", { step: 0.002, gap: 0.02 });
  assert.ok(saved.ok, saved.error);
  assert.strictEqual(s.cruise.minSpread, 0.021);
  s.cruise.on = true;
  saved = await cruise.saveGrid("u", "159781.SZ", { step: 0.003, gap: 0.03 });
  assert.ok(!saved.ok && saved.locked);
  assert.strictEqual(s.cruise.step, 0.002, "on cruise ignores a new step");
  console.log("17 grid save locked while on");

  // 18. enable uses the saved step and gap, not the hardcoded profile
  reset({ bid1: 0.994, ask1: 0.995, orders: [order("sell", 1.001, 5000, 50, 1)], deals: [] });
  s.cruise.step = 0.002;
  s.cruise.reverseGap = 0.02;
  s.cruise.minSpread = 0.021;
  out = await cruise.enableCruise("u", "159781.SZ", 5000);
  assert.ok(out.ok, out.error);
  assert.strictEqual(prices("sell")[0], "1.003");
  assert.strictEqual(prices("buy")[0], "0.980");
  assert.ok(s.logs.some((line) => line.includes("步长 0.002") && line.includes("价差 0.020")));
  console.log("18 custom grid enable:", prices("sell")[0], prices("buy")[0]);

  // 19. 516310: 价差 0.006, 买卖间距 0.007. After 1.400 sells, the new edge is 1.394,
  // one tick above the existing 1.393 buy. That level gets one order, 1.393 is not stacked.
  s.cruise = { on: true, qty: 5000, rungs: [], dropped: [], lastDeal: null, prevDeal: null };
  s.snapshot = {
    account: "A", stock: "516310.SH", updatedAt: 1, bid1: 1.394, ask1: 1.401,
    orders: [
      order("sell", 1.4, 0, 56, "S1400"),
      order("sell", 1.401, 5000, 50, "S1401"),
      order("buy", 1.393, 5000, 50, "B1393"),
    ],
    deals: [deal("sell", 1.4, 5000, "D1400", "S1400", "100000")],
  };
  s.pending = [];
  s.placed = [];
  s.seen = new Set();
  s.logs = [];
  await cruise.tickOne({ username: "u", stock: "516310.SH", qty: 5000 });
  assert.ok(!s.placed.some((o) => o.side === "buy" && o.price === 1.393), `stacked 1.393: ${summary(s.placed)}`);
  const edge = s.placed.find((o) => o.side === "buy" && o.price === 1.394);
  assert.ok(edge && edge.qty === 5000, summary(s.placed));
  console.log("19 spread kept without stacking:", summary(s.placed.filter((o) => o.price >= 1.393 && o.price <= 1.395)));

  console.log("\nlast engine logs:\n  " + s.logs.slice(-6).join("\n  "));
  console.log("\nALL PASSED");
})().catch((err) => {
  console.error("FAILED:", err.stack || err.message);
  process.exit(1);
});
