const OPEN_STATUS = new Set([48, 49, 50, 51, 52, 55]);
const CANCEL_STATUS = new Set([53, 54, 57]);
const TICK = 0.001;
const LADDER_PAD = 15;
const PRECLOSE_PAD = 10;
const QTY_KEY = "qmt_hang_qty";
const QTY_STEP = 1000;
const QTY_PAD = 5;
const QTY_ABS_MIN = 1000;
const QTY_ABS_MAX = 1000000;
const QTY_DEFAULT = 10000;
const STOCK_KEY = "qmt_selected_stock";
const STOCKS = [
  {
    id: "159781.SZ",
    label: "159781",
    name: "科创创业ETF易方达",
    buyStep: 0.001,
    sellStep: 0.001,
    reverseGap: 0.011,
    minSpread: 0.012,
    levels: 10,
    qtyDefault: 10000,
    simBid: 1.066,
    simAsk: 1.067,
  },
  {
    id: "516310.SH",
    label: "516310",
    name: "银行ETF",
    buyStep: 0.005,
    sellStep: 0.005,
    reverseGap: 0.006,
    minSpread: 0.006,
    levels: 10,
    qtyDefault: 10000,
    simBid: 1.385,
    simAsk: 1.391,
  },
];
const REQUEST_FADE_MS = 3000;
const HANG_BAR_IDLE_MS = 5000;
const HANG_BAR_FADE_MS = 3000;

const cruiseHolder = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
let lastMetaText = "";
let lastSyncText = "";
let refreshing = false;
let viewEpoch = 0;
let pendingHang = null;
let hangSubmitting = false;
let pendingCancel = null;
let cancelSubmitting = false;
let cancelBarTimer = null;
let cancelBarFadeTimer = null;
let hangBarTimer = null;
let hangBarFadeTimer = null;
let fadeCleanupTimer = null;
let cruiseOn = false;
const stockNamespaces = new Map();

function emptyNs(id) {
  return {
    id,
    data: null,
    version: 0,
    emptyStreak: 0,
    ladderKey: "",
    quoteKey: "",
    fadingHangs: new Map(),
    lastPendingList: [],
    cruiseOn: false,
    cruiseBusy: false,
    seenDeals: new Set(),
    seenFails: new Set(),
    rungs: [],
    dropped: new Set(),
    rungsSig: "",
    lastDeal: null,
    prevDeal: null,
    loaded: false,
    seedNote: "",
    sellGapFrom: 0,
    sellGapTop: 0,
    buyGapFrom: 0,
    buyGapLow: 0,
    gapNoteSell: "",
    gapNoteBuy: "",
  };
}

function stockNs(stock) {
  const id = normalizeStockId(stock || selectedStock());
  if (!stockNamespaces.has(id)) stockNamespaces.set(id, emptyNs(id));
  return stockNamespaces.get(id);
}

function activeNs() {
  return stockNs(selectedStock());
}

function getLastGoodData() {
  return activeNs().data;
}

function setLastGoodData(data) {
  const ns = activeNs();
  ns.data = data;
  if (data && data.version) ns.version = Number(data.version) || ns.version;
}

function cruiseBook(stock) {
  const ns = stockNs(stock);
  if (!Object.prototype.hasOwnProperty.call(ns, "on")) {
    Object.defineProperty(ns, "on", {
      get() { return this.cruiseOn; },
      set(v) { this.cruiseOn = Boolean(v); },
      enumerable: true,
      configurable: true,
    });
  }
  if (!Object.prototype.hasOwnProperty.call(ns, "busy")) {
    Object.defineProperty(ns, "busy", {
      get() { return this.cruiseBusy; },
      set(v) { this.cruiseBusy = Boolean(v); },
      enumerable: true,
      configurable: true,
    });
  }
  return ns;
}

function normalizeStockId(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return STOCKS[0].id;
  const short = raw.replace(/\.SZ$/, "").replace(/\.SH$/, "");
  const hit = STOCKS.find(
    (s) => s.id === raw || s.label === raw || s.label === short || s.id.startsWith(`${short}.`)
  );
  return hit ? hit.id : STOCKS[0].id;
}

function selectedStock() {
  try {
    return normalizeStockId(localStorage.getItem(STOCK_KEY));
  } catch (_err) {
    return STOCKS[0].id;
  }
}

function setSelectedStock(id) {
  const next = normalizeStockId(id);
  try {
    localStorage.setItem(STOCK_KEY, next);
  } catch (_err) {}
  return next;
}

function stockProfile(stock) {
  const id = normalizeStockId(stock || selectedStock());
  return STOCKS.find((s) => s.id === id) || STOCKS[0];
}

function stockHeadline(stock) {
  const s = stockProfile(stock);
  return s.name ? `${s.id}  ${s.name}` : s.id;
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

function statusCode(row) {
  return num(row.m_nOrderStatus || row.status);
}

function orderPrice(row) {
  return num(row.m_dLimitPrice || row.price);
}

function dealPrice(row) {
  return num(row.m_dPrice || row.price);
}

function tickDigits(tick) {
  return Math.max(0, String(tick).split(".")[1]?.length || 0);
}

function tickScale(tick) {
  return Math.round(1 / tick);
}

function priceToIdx(price, tick) {
  return Math.round(num(price) * tickScale(tick));
}

function idxToPrice(idx, tick) {
  return idx / tickScale(tick);
}

function fmtPriceIdx(idx, tick) {
  return idxToPrice(idx, tick).toFixed(tickDigits(tick));
}

function pruneFadingHangs(stock) {
  const ns = stockNs(stock);
  const now = Date.now();
  for (const [id, ghost] of ns.fadingHangs) {
    if (now - ghost.started >= REQUEST_FADE_MS) ns.fadingHangs.delete(id);
  }
}

function scheduleFadeCleanup() {
  if (fadeCleanupTimer) return;
  let wait = REQUEST_FADE_MS;
  const now = Date.now();
  const ns = activeNs();
  for (const ghost of ns.fadingHangs.values()) {
    wait = Math.min(wait, Math.max(0, REQUEST_FADE_MS - (now - ghost.started)));
  }
  fadeCleanupTimer = setTimeout(() => {
    fadeCleanupTimer = null;
    pruneFadingHangs(selectedStock());
    const data = getLastGoodData();
    if (data) {
      renderLadder(buildLevels(data, tickValue()), tickValue(), data);
    }
    if (activeNs().fadingHangs.size) scheduleFadeCleanup();
  }, wait + 40);
}

function syncFadingHangs(list, stock) {
  const ns = stockNs(stock || selectedStock());
  const next = Array.isArray(list) ? list : [];
  const nextIds = new Set(next.map((x) => String(x.id)));
  for (const old of ns.lastPendingList) {
    const id = String(old.id);
    if (!nextIds.has(id) && !ns.fadingHangs.has(id)) {
      ns.fadingHangs.set(id, { ...old, started: Date.now() });
    }
  }
  for (const id of [...ns.fadingHangs.keys()]) {
    if (nextIds.has(id)) ns.fadingHangs.delete(id);
  }
  ns.lastPendingList = next;
  pruneFadingHangs(ns.id);
  if (ns.id === selectedStock() && ns.fadingHangs.size) scheduleFadeCleanup();
}

function pendingHangsForLadder(data) {
  const stock = normalizeStockId((data && data.stock) || selectedStock());
  const ns = stockNs(stock);
  const live = data && Array.isArray(data.pendingHangs) ? data.pendingHangs : [];
  syncFadingHangs(live, stock);
  const ghosts = [...ns.fadingHangs.values()].map((g) => ({
    id: g.id,
    side: g.side,
    price: g.price,
    qty: g.qty,
    status: g.status || "pending",
    fading: true,
  }));
  return live.concat(ghosts);
}

function fmtQty(qty) {
  if (!qty) return "";
  return String(Math.round(qty));
}

function fmtQtyCompact(qty) {
  const n = Math.round(num(qty));
  if (!n) return "";
  if (n >= 1000 && n % 1000 === 0) return `${n / 1000}K`;
  if (n >= 1000) return `${Number((n / 1000).toFixed(1))}K`;
  return String(n);
}

function dualTagText(full, compact) {
  return `<span class="tag-full">${full}</span><span class="tag-compact">${compact}</span>`;
}

function itemsKey(items) {
  return (items || [])
    .map((it) => `${it.side}:${it.request ? "r" : "l"}:${it.id}:${it.qty}:${it.status || ""}:${it.fading ? "f" : ""}:${it.cancelPending ? "c" : ""}`)
    .join(",");
}

function buildLevels(data, tick) {
  const hangs = { buy: new Map(), sell: new Map() };
  const fills = { buy: new Map(), sell: new Map() };
  const cancels = { buy: new Map(), sell: new Map() };
  const idxs = [];
  const canceling = new Set(
    (data.pendingCancels || [])
      .map((x) => String(x.targetOrderId || x.target_order_id || ""))
      .filter(Boolean)
  );

  function pushItem(map, price, item, mergeById) {
    if (!item.qty) return;
    const idx = priceToIdx(price, tick);
    idxs.push(idx);
    const list = map.get(idx) || [];
    if (mergeById && item.id) {
      const existing = list.find((x) => x.id === item.id && x.side === item.side);
      if (existing) {
        existing.qty += item.qty;
        map.set(idx, list);
        return;
      }
    }
    list.push(item);
    map.set(idx, list);
  }

  function addCancel(map, price, qty) {
    if (!qty) return;
    const idx = priceToIdx(price, tick);
    idxs.push(idx);
    map.set(idx, (map.get(idx) || 0) + qty);
  }

  const orderRows = data.orders && data.orders.length ? data.orders : data.openOrders || [];
  for (const row of orderRows) {
    const side = optSide(row) || "buy";
    const status = statusCode(row);
    const original = num(row.m_nVolumeTotalOriginal || row.qty);
    const traded = num(row.m_nVolumeTraded);
    const remaining = num(row.m_nVolumeTotal);
    const cancelAmt = num(row.m_dCancelAmount);
    const orderId = String(row.order_id || row.m_strOrderSysID || row.m_strOrderRef || "");
    if (OPEN_STATUS.has(status) && remaining) {
      pushItem(
        hangs[side],
        orderPrice(row),
        { qty: remaining, id: orderId, side, cancelPending: canceling.has(String(orderId)) },
        false
      );
    }
    if (CANCEL_STATUS.has(status) || cancelAmt) {
      addCancel(cancels[side], orderPrice(row), cancelAmt || Math.max(0, original - traded));
    }
  }

  for (const row of data.deals || []) {
    const side = optSide(row) || "buy";
    const orderId = String(row.order_id || row.m_strOrderSysID || row.m_strOrderRef || "");
    pushItem(
      fills[side],
      dealPrice(row),
      { qty: num(row.m_nVolume || row.qty), id: orderId, side },
      true
    );
  }

  for (const row of pendingHangsForLadder(data)) {
    const side = row.side === "sell" ? "sell" : "buy";
    pushItem(
      hangs[side],
      num(row.price),
      {
        qty: num(row.qty),
        id: `req-${row.id}`,
        side,
        request: true,
        status: row.status || "pending",
        fading: Boolean(row.fading),
      },
      false
    );
  }

  if (num(data.bid1) > 0) idxs.push(priceToIdx(data.bid1, tick));
  if (num(data.ask1) > 0) idxs.push(priceToIdx(data.ask1, tick));

  const hasQuote = num(data.bid1) > 0 || num(data.ask1) > 0;
  const preClose = num(data.preClose) || num(data.lastClose) || (!hasQuote ? num(data.lastPrice) : 0);
  if (!hasQuote && preClose > 0) idxs.push(priceToIdx(preClose, tick));

  if (!idxs.length) return [];

  let min = Math.min(...idxs);
  let max = Math.max(...idxs);
  if (num(data.bid1) > 0) {
    const bidIdx = priceToIdx(data.bid1, tick);
    min = Math.min(min, bidIdx - LADDER_PAD);
  }
  if (num(data.ask1) > 0) {
    const askIdx = priceToIdx(data.ask1, tick);
    max = Math.max(max, askIdx + LADDER_PAD);
  }
  if (!hasQuote && preClose > 0) {
    const mid = priceToIdx(preClose, tick);
    min = Math.min(min, mid - PRECLOSE_PAD);
    max = Math.max(max, mid + PRECLOSE_PAD);
  }
  const levels = [];
  for (let idx = max; idx >= min; idx -= 1) {
    levels.push({
      idx,
      priceLabel: fmtPriceIdx(idx, tick),
      hangBuy: hangs.buy.get(idx) || [],
      hangSell: hangs.sell.get(idx) || [],
      fillBuy: fills.buy.get(idx) || [],
      fillSell: fills.sell.get(idx) || [],
      cancelBuy: cancels.buy.get(idx) || 0,
      cancelSell: cancels.sell.get(idx) || 0,
    });
  }
  return levels;
}

function rowEmpty(row) {
  return (
    !row.hangBuy.length &&
    !row.hangSell.length &&
    !row.fillBuy.length &&
    !row.fillSell.length &&
    !row.cancelBuy &&
    !row.cancelSell
  );
}

function rowKey(row) {
  return [
    row.idx,
    itemsKey(row.hangBuy),
    itemsKey(row.hangSell),
    itemsKey(row.fillBuy),
    itemsKey(row.fillSell),
    row.cancelBuy,
    row.cancelSell,
  ].join("|");
}

function ladderFingerprint(levels, tick, data) {
  const bid = num(data && data.bid1);
  const ask = num(data && data.ask1);
  const pre = num(data && data.preClose) || num(data && data.lastClose) || num(data && data.lastPrice);
  return `${tick}::${bid}::${ask}::${pre}::` + levels.map(rowKey).join(";");
}

function hangTagHtml(item) {
  const sell = item.side === "sell";
  const label = sell ? "卖挂" : "买挂";
  if (item.request) {
    const st = item.status === "claimed" ? "执行中" : "待执行";
    const fade = item.fading ? " fade-out" : "";
    return `<span class="tag hang ${sell ? "sell" : "buy"} request${fade}" data-order-id="${String(item.id || "").replace(/"/g, "")}" data-side="${sell ? "sell" : "buy"}" data-qty="${num(item.qty)}">${label} ${fmtQty(item.qty)} ${st}</span>`;
  }
  const extra = item.cancelPending ? " canceling" : " live";
  const suffix = item.cancelPending ? " 撤单中" : "";
  const oid = String(item.id || "").replace(/"/g, "");
  return `<span class="tag hang ${sell ? "sell" : "buy"}${extra}" data-order-id="${oid}" data-side="${sell ? "sell" : "buy"}" data-qty="${num(item.qty)}">${label} ${fmtQty(item.qty)}${suffix}</span>`;
}

function fillTagHtml(items, side) {
  if (!items.length) return "";
  const qtys = items.map((it) => num(it.qty));
  const n = qtys.length;
  const label = side === "sell" ? "卖成" : "买成";
  const same = qtys.every((q) => q === qtys[0]);
  const total = qtys.reduce((sum, q) => sum + q, 0);
  const unit = n > 1 && same ? qtys[0] : total;
  const full = n > 1 && same ? `${label} ${fmtQty(unit)} x ${n}` : `${label} ${fmtQty(unit)}`;
  const compact = n > 1 && same ? `${fmtQtyCompact(unit)} x ${n}` : fmtQtyCompact(unit);
  return `<span class="tag fill ${side}" title="${full}">${dualTagText(full, compact)}</span>`;
}

function tagsHtml(row) {
  const hangs = [];
  const fills = [];
  const cancels = [];
  for (const item of row.hangBuy) hangs.push(hangTagHtml(item));
  for (const item of row.hangSell) hangs.push(hangTagHtml(item));
  fills.push(fillTagHtml(row.fillBuy, "buy"));
  fills.push(fillTagHtml(row.fillSell, "sell"));
  if (row.cancelBuy) cancels.push(`<span class="tag cancel">买撤 ${fmtQty(row.cancelBuy)}</span>`);
  if (row.cancelSell) cancels.push(`<span class="tag cancel">卖撤 ${fmtQty(row.cancelSell)}</span>`);
  return { hangs: hangs.join(""), fills: fills.join(""), cancels: cancels.join("") };
}

function createRowEl(row) {
  const tags = tagsHtml(row);
  const el = document.createElement("div");
  el.className = `ladder-row${rowEmpty(row) ? " empty" : ""}`;
  el.dataset.idx = String(row.idx);
  el.dataset.key = rowKey(row);
  el.innerHTML = `
    <div class="price">${row.priceLabel}</div>
    <div class="cells hangs">${tags.hangs}</div>
    <div class="cells fills">${tags.fills}</div>
    <div class="cells cancels">${tags.cancels}</div>`;
  return el;
}

function patchRowEl(el, row) {
  const key = rowKey(row);
  if (el.dataset.key === key) return false;
  const tags = tagsHtml(row);
  el.className = `ladder-row${rowEmpty(row) ? " empty" : ""}`;
  el.dataset.key = key;
  const price = el.querySelector(".price");
  const hangs = el.querySelector(".hangs");
  const fills = el.querySelector(".fills");
  const cancels = el.querySelector(".cancels");
  if (price && price.textContent !== row.priceLabel) price.textContent = row.priceLabel;
  if (hangs && hangs.innerHTML !== tags.hangs) hangs.innerHTML = tags.hangs;
  if (fills && fills.innerHTML !== tags.fills) fills.innerHTML = tags.fills;
  if (cancels && cancels.innerHTML !== tags.cancels) cancels.innerHTML = tags.cancels;
  return true;
}

function applyQuoteClasses(root, data, tick) {
  const bid = num(data && data.bid1);
  const ask = num(data && data.ask1);
  const hasQuote = bid > 0 || ask > 0;
  const preClose = num(data && data.preClose) || num(data && data.lastClose) || (!hasQuote ? num(data && data.lastPrice) : 0);
  const bidIdx = bid > 0 ? priceToIdx(bid, tick) : null;
  const askIdx = ask > 0 ? priceToIdx(ask, tick) : null;
  const preIdx = !hasQuote && preClose > 0 ? priceToIdx(preClose, tick) : null;
  for (const el of root.querySelectorAll(".ladder-row[data-idx]")) {
    const idx = Number(el.dataset.idx);
    el.classList.toggle("quote-bid", bidIdx != null && idx === bidIdx);
    el.classList.toggle("quote-ask", askIdx != null && idx === askIdx);
    el.classList.toggle("quote-preclose", preIdx != null && idx === preIdx);
    const canBuy = bidIdx != null && idx <= bidIdx;
    const canSell = askIdx != null && idx >= askIdx;
    el.classList.toggle("can-buy", canBuy);
    el.classList.toggle("can-sell", canSell);
    el.classList.toggle("no-hang", !canBuy && !canSell);
  }
  const key = `${bidIdx}|${askIdx}|${preIdx}`;
  activeNs().quoteKey = key;
}

function renderLadder(levels, tick, data) {
  const root = document.getElementById("ladder");
  const section = root.closest(".ladder-section");
  const scrollTop = section ? section.scrollTop : 0;
  const fingerprint = ladderFingerprint(levels, tick, data);

  if (!levels.length) {
    // 偶发空响应不立刻清空，避免整表闪没
    return;
  }

  if (fingerprint !== activeNs().ladderKey) {
    const byIdx = new Map();
    for (const el of root.querySelectorAll(".ladder-row[data-idx]")) {
      byIdx.set(el.dataset.idx, el);
    }

    // 去掉「暂无数据」占位
    for (const el of root.querySelectorAll(".ladder-row.empty:not([data-idx])")) {
      el.remove();
    }

    const nextEls = [];
    for (const row of levels) {
      const id = String(row.idx);
      let el = byIdx.get(id);
      if (el) {
        patchRowEl(el, row);
        byIdx.delete(id);
      } else {
        el = createRowEl(row);
      }
      nextEls.push(el);
    }

    // 就地重排/插入，不整表 replaceChildren
    let cursor = root.firstChild;
    for (const el of nextEls) {
      if (cursor === el) {
        cursor = cursor.nextSibling;
        continue;
      }
      root.insertBefore(el, cursor);
    }
    for (const el of byIdx.values()) {
      el.remove();
    }

    if (section) section.scrollTop = scrollTop;
    activeNs().ladderKey = fingerprint;
  }

  applyQuoteClasses(root, data, tick);
}

function parseEpochMs(ts) {
  if (ts == null || ts === "") return null;
  if (typeof ts === "number" && Number.isFinite(ts)) {
    return ts < 1e12 ? ts * 1000 : ts;
  }
  if (typeof ts === "string" && /^\d+(\.\d+)?$/.test(ts.trim())) {
    const n = Number(ts);
    return n < 1e12 ? n * 1000 : n;
  }
  const d = new Date(ts);
  const t = d.getTime();
  return Number.isNaN(t) ? null : t;
}

function formatTs(ts) {
  const ms = parseEpochMs(ts);
  if (ms == null) return String(ts);
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  const zone =
    new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
      .formatToParts(d)
      .find((p) => p.type === "timeZoneName") || {};
  const suffix = zone.value ? ` ${zone.value}` : "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${suffix}`;
}

function setLatestSync(ts) {
  const text = ts ? `Latest Sync: ${formatTs(ts)}` : "Latest Sync: --";
  if (text === lastSyncText) return;
  lastSyncText = text;
  const el = document.getElementById("latest-sync");
  if (el) el.textContent = text;
}

function setMeta(text) {
  if (text === lastMetaText) return;
  lastMetaText = text;
  document.getElementById("meta").textContent = text;
}

function rememberVersion(version, stock) {
  const v = Number(version);
  if (Number.isFinite(v) && v > 0) {
    stockNs(stock || selectedStock()).version = v;
  }
}

function sinceForStock(stock) {
  return stockNs(stock || selectedStock()).version || 0;
}

function isLocalHost() {
  return /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(location.hostname);
}

function isSimMode() {
  return isLocalHost() && new URLSearchParams(location.search).get("mode") === "sim";
}

function setSimMode(on) {
  const url = new URL(location.href);
  if (on) url.searchParams.set("mode", "sim");
  else url.searchParams.delete("mode");
  location.assign(url.pathname + url.search + url.hash);
}

function applySimChrome() {
  const on = isSimMode();
  document.documentElement.dataset.sim = on ? "1" : "0";
  const btn = document.getElementById("sim-toggle");
  if (btn) {
    btn.hidden = !isLocalHost();
    btn.classList.toggle("active", on);
    btn.title = on ? "退出调试模式" : "进入调试模式";
  }
}

function orderIdOf(row) {
  return String(row.order_id || row.m_strOrderSysID || row.m_strOrderRef || "");
}

function rebuildOpenOrders(orders) {
  return (orders || []).filter((row) => OPEN_STATUS.has(statusCode(row)));
}

function snapshotForSync(data) {
  const orders = JSON.parse(JSON.stringify(data.orders || []));
  return {
    account: data.account || "SIM",
    stock: data.stock || selectedStock(),
    bid1: num(data.bid1),
    ask1: num(data.ask1),
    preClose: num(data.preClose) || num(data.lastClose) || 0,
    lastPrice: num(data.lastPrice) || num(data.bid1) || num(data.preClose),
    source: "sim",
    orders,
    openOrders: rebuildOpenOrders(orders),
    deals: JSON.parse(JSON.stringify(data.deals || [])),
  };
}

function makeSimOrder({ side, price, qty, status, remaining, traded, cancelAmt, id }) {
  const oid = id || `sim-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`;
  const buy = side !== "sell";
  return {
    m_strOptName: buy ? "买入" : "卖出",
    m_dLimitPrice: Number(price),
    price: Number(price),
    m_nVolumeTotalOriginal: qty,
    qty,
    m_nVolumeTotal: remaining != null ? remaining : qty,
    m_nVolumeTraded: traded || 0,
    m_dCancelAmount: cancelAmt || 0,
    m_nOrderStatus: status,
    status,
    m_strOrderSysID: oid,
    order_id: oid,
  };
}

async function postSimSnapshot(data) {
  const payload = snapshotForSync(data);
  const res = await fetch("/api/sync", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.ok) throw new Error(out.error || `HTTP ${res.status}`);
  setLastGoodData({
    ...payload,
    pendingHangs: (data && data.pendingHangs) || (getLastGoodData() && getLastGoodData().pendingHangs) || [],
    pendingCancels: (data && data.pendingCancels) || (getLastGoodData() && getLastGoodData().pendingCancels) || [],
    updatedAt: out.updatedAt || Date.now(),
    version: out.version || 0,
  });
  rememberVersion(getLastGoodData().version, selectedStock());
  setLatestSync(getLastGoodData().updatedAt);
  renderLadder(buildLevels(getLastGoodData(), tickValue()), tickValue(), getLastGoodData());
  if (cruiseOn && isSimMode()) {
    await cruiseTick(getLastGoodData());
  }
  return getLastGoodData();
}

async function ensureSimQuote() {
  if (getLastGoodData() && (num(getLastGoodData().bid1) > 0 || num(getLastGoodData().ask1) > 0)) {
    return getLastGoodData();
  }
  const profile = stockProfile(selectedStock());
  const bid = profile.simBid || 1.066;
  const ask = profile.simAsk || bid + TICK;
  return postSimSnapshot({
    account: "SIM",
    stock: selectedStock(),
    bid1: bid,
    ask1: ask,
    lastPrice: bid,
    orders: [],
    deals: [],
  });
}

async function simPlaceHang(side, price, qty) {
  const snap = await ensureSimQuote();
  const orders = (snap.orders || []).slice();
  orders.push(makeSimOrder({ side, price, qty, status: 50 }));
  snap.orders = orders;
  await postSimSnapshot(snap);
}

function patchOrder(orders, orderId, fn) {
  const oid = String(orderId);
  let found = false;
  for (const row of orders) {
    if (orderIdOf(row) === oid) {
      fn(row);
      found = true;
    }
  }
  return found;
}

async function simAdvanceToFill(info) {
  const snap = await ensureSimQuote();
  await finishPendingRequest(info, info.orderId);
  const orders = (snap.orders || []).slice();
  const qty = num(info.qty);
  const found = patchOrder(orders, info.orderId, (row) => {
    const original = num(row.m_nVolumeTotalOriginal || row.qty || qty);
    row.m_nOrderStatus = 56;
    row.status = 56;
    row.m_nVolumeTraded = original;
    row.m_nVolumeTotal = 0;
  });
  if (!found) {
    orders.push(
      makeSimOrder({
        side: info.side,
        price: info.price,
        qty,
        status: 56,
        remaining: 0,
        traded: qty,
        id: info.orderId,
      })
    );
  }
  snap.orders = orders;
  snap.deals = (snap.deals || []).concat([
    {
      m_strOptName: info.side === "sell" ? "卖出" : "买入",
      m_dPrice: Number(info.price),
      m_nVolume: qty,
      qty,
      m_strOrderSysID: info.orderId,
      order_id: info.orderId,
    },
  ]);
  await postSimSnapshot(snap);
}

async function simAdvanceToCancel(info) {
  const snap = await ensureSimQuote();
  await finishPendingRequest(info, info.orderId);
  const orders = (snap.orders || []).slice();
  const qty = num(info.qty);
  const found = patchOrder(orders, info.orderId, (row) => {
    const original = num(row.m_nVolumeTotalOriginal || row.qty || qty);
    row.m_nOrderStatus = 54;
    row.status = 54;
    row.m_dCancelAmount = original;
    row.m_nVolumeTotal = 0;
  });
  if (!found) {
    orders.push(
      makeSimOrder({
        side: info.side,
        price: info.price,
        qty,
        status: 54,
        remaining: 0,
        cancelAmt: qty,
        id: info.orderId,
      })
    );
  }
  snap.orders = orders;
  await postSimSnapshot(snap);
}

async function finishPendingRequest(info, brokerOrderId) {
  if (!info || !info.request) return;
  const raw = String(info.orderId || "").replace(/^req-/, "");
  if (getLastGoodData()) {
    getLastGoodData().pendingHangs = (getLastGoodData().pendingHangs || []).filter((x) => String(x.id) !== raw);
  }
  const nsFade = activeNs();
  nsFade.fadingHangs.delete(raw);
  nsFade.lastPendingList = nsFade.lastPendingList.filter((x) => String(x.id) !== raw);
  const id = Number(raw);
  if (!Number.isFinite(id) || id <= 0) return;
  await fetch(`/api/commands/${id}/result`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true, brokerOrderId: brokerOrderId || "" }),
  }).catch(() => {});
}

async function simAdvanceToLive(info) {
  const snap = await ensureSimQuote();
  const oid = `sim-${Date.now().toString(36)}`;
  await finishPendingRequest(info, oid);
  const orders = (snap.orders || []).slice();
  orders.push(
    makeSimOrder({
      side: info.side,
      price: info.price,
      qty: num(info.qty),
      status: 50,
      id: oid,
    })
  );
  snap.orders = orders;
  snap.pendingHangs = (getLastGoodData() && getLastGoodData().pendingHangs) || [];
  await postSimSnapshot(snap);
}

function clearSimBarActions(bar) {
  if (!bar) return;
  for (const el of bar.querySelectorAll(".sim-btn")) el.remove();
}

function setSimBarActions(bar, actions) {
  clearSimBarActions(bar);
  if (!isSimMode() || !bar) return;
  for (const act of actions) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hang-btn sim-btn";
    btn.textContent = act.label;
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      Promise.resolve(act.run())
        .then(() => {
          hideHangBar();
          hideCancelBar();
        })
        .catch((err) => setMeta(`模拟失败: ${err.message}`));
    });
    bar.appendChild(btn);
  }
}

function tickValue() {
  return TICK;
}

function snapQty(value) {
  let n = Math.round(Number(value) / QTY_STEP) * QTY_STEP;
  if (!Number.isFinite(n)) n = QTY_DEFAULT;
  if (n < QTY_ABS_MIN) return QTY_ABS_MIN;
  if (n > QTY_ABS_MAX) return QTY_ABS_MAX;
  return n;
}

function qtyWindow(center) {
  const value = snapQty(center);
  let min = value - QTY_PAD * QTY_STEP;
  let max = value + QTY_PAD * QTY_STEP;
  if (min < QTY_ABS_MIN) {
    min = QTY_ABS_MIN;
    max = min + QTY_PAD * 2 * QTY_STEP;
  }
  if (max > QTY_ABS_MAX) {
    max = QTY_ABS_MAX;
    min = Math.max(QTY_ABS_MIN, max - QTY_PAD * 2 * QTY_STEP);
  }
  return { min, max, value };
}

function qtyStorageKey(stock) {
  return `${QTY_KEY}:${normalizeStockId(stock || selectedStock())}`;
}

function readSavedQty(stock) {
  const id = normalizeStockId(stock || selectedStock());
  let raw = "";
  try {
    raw = localStorage.getItem(qtyStorageKey(id));
    if ((raw == null || raw === "") && id === STOCKS[0].id) {
      raw = localStorage.getItem(QTY_KEY);
    }
  } catch (_err) {
    raw = "";
  }
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return snapQty(n);
  return snapQty(stockProfile(id).qtyDefault || QTY_DEFAULT);
}

function hangQty(stock) {
  const id = normalizeStockId(stock || selectedStock());
  if (id === selectedStock()) {
    const el = document.getElementById("hang-qty");
    if (el && el.value) return snapQty(el.value);
  }
  return readSavedQty(id);
}

function applyHangQtyForStock(stock) {
  renderHangQty(readSavedQty(stock), { recenter: true, force: true });
}

function loadHangQty() {
  const el = document.getElementById("hang-qty");
  if (!el) return;
  applyHangQtyForStock(selectedStock());
  if (el.dataset.wired) return;
  el.dataset.wired = "1";
  el.addEventListener("input", () => {
    const n = renderHangQty(el.value);
    try {
      localStorage.setItem(qtyStorageKey(selectedStock()), String(n));
    } catch (_err) {}
  });
  el.addEventListener("change", () => {
    const n = renderHangQty(el.value, { recenter: true });
    try {
      localStorage.setItem(qtyStorageKey(selectedStock()), String(n));
    } catch (_err) {}
  });
}

function renderHangQty(n, opts) {
  const el = document.getElementById("hang-qty");
  const label = document.getElementById("hang-qty-value");
  const qty = snapQty(n);
  if (el) {
    const minNow = Number(el.min);
    const maxNow = Number(el.max);
    const atEdge = qty <= minNow || qty >= maxNow;
    if (opts && opts.recenter && (opts.force || atEdge)) {
      const w = qtyWindow(qty);
      el.min = String(w.min);
      el.max = String(w.max);
    }
    el.value = String(qty);
  }
  if (label) label.textContent = String(qty);
  return qty;
}

function hideHangBar(opts) {
  const fade = Boolean(opts && opts.fade);
  if (hangBarTimer) {
    clearTimeout(hangBarTimer);
    hangBarTimer = null;
  }
  if (hangBarFadeTimer) {
    clearTimeout(hangBarFadeTimer);
    hangBarFadeTimer = null;
  }
  const bar = document.getElementById("hang-bar");
  if (!bar) {
    pendingHang = null;
    return;
  }
  if (!fade || bar.classList.contains("hidden")) {
    pendingHang = null;
    bar.classList.remove("fade-out");
    bar.classList.add("hidden");
    return;
  }
  bar.classList.add("fade-out");
  hangBarFadeTimer = setTimeout(() => {
    hangBarFadeTimer = null;
    pendingHang = null;
    bar.classList.remove("fade-out");
    bar.classList.add("hidden");
  }, HANG_BAR_FADE_MS);
}

function ensureHangBar() {
  let bar = document.getElementById("hang-bar");
  if (bar && bar.parentNode === document.body) {
    wireHangBarButtons();
    return bar;
  }
  if (bar && bar.parentNode !== document.body) {
    bar.remove();
  }
  bar = document.createElement("div");
  bar.id = "hang-bar";
  bar.className = "hang-bar hidden";
  bar.innerHTML = `
    <span id="hang-bar-text"></span>
    <button type="button" id="hang-confirm" class="hang-btn confirm">确认</button>
    <button type="button" id="hang-cancel" class="hang-btn cancel">取消</button>`;
  document.body.appendChild(bar);
  wireHangBarButtons();
  return bar;
}

function wireHangBarButtons() {
  const confirmBtn = document.getElementById("hang-confirm");
  const cancelBtn = document.getElementById("hang-cancel");
  if (confirmBtn && !confirmBtn.dataset.wired) {
    confirmBtn.dataset.wired = "1";
    confirmBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      submitHang().catch(() => {});
    });
  }
  if (cancelBtn && !cancelBtn.dataset.wired) {
    cancelBtn.dataset.wired = "1";
    cancelBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      hideHangBar();
    });
  }
}

function placeHangBar(bar, clientX, clientY) {
  bar.style.left = "0px";
  bar.style.top = "0px";
  const w = bar.offsetWidth || 220;
  const h = bar.offsetHeight || 40;
  const pad = 8;
  let left = clientX + 12;
  let top = clientY - Math.round(h / 2);
  if (left + w + pad > window.innerWidth) left = clientX - w - 12;
  if (left < pad) left = pad;
  if (top + h + pad > window.innerHeight) top = window.innerHeight - h - pad;
  if (top < pad) top = pad;
  bar.style.left = `${Math.round(left)}px`;
  bar.style.top = `${Math.round(top)}px`;
}

function showHangBar(side, price, point) {
  hideCancelBar();
  pendingHang = { side, price };
  const bar = ensureHangBar();
  const text = document.getElementById("hang-bar-text");
  if (!bar || !text) {
    setMeta("确认栏加载失败，请强制刷新页面");
    return;
  }
  const label = side === "buy" ? "买挂" : "卖挂";
  text.textContent = `${label} ${price.toFixed(3)} × ${hangQty()}`;
  if (hangBarFadeTimer) {
    clearTimeout(hangBarFadeTimer);
    hangBarFadeTimer = null;
  }
  bar.classList.remove("hidden", "fade-out");
  bar.classList.toggle("buy", side === "buy");
  bar.classList.toggle("sell", side === "sell");
  const x = point && Number.isFinite(point.x) ? point.x : window.innerWidth / 2;
  const y = point && Number.isFinite(point.y) ? point.y : window.innerHeight / 2;
  placeHangBar(bar, x, y);
  setSimBarActions(bar, []);
  if (hangBarTimer) clearTimeout(hangBarTimer);
  hangBarTimer = setTimeout(() => {
    hangBarTimer = null;
    hideHangBar({ fade: true });
  }, HANG_BAR_IDLE_MS);
}

function hideCancelBar(opts) {
  const fade = Boolean(opts && opts.fade);
  if (cancelBarTimer) {
    clearTimeout(cancelBarTimer);
    cancelBarTimer = null;
  }
  if (cancelBarFadeTimer) {
    clearTimeout(cancelBarFadeTimer);
    cancelBarFadeTimer = null;
  }
  const bar = document.getElementById("cancel-bar");
  if (!bar) {
    pendingCancel = null;
    return;
  }
  if (!fade || bar.classList.contains("hidden")) {
    pendingCancel = null;
    bar.classList.remove("fade-out");
    bar.classList.add("hidden");
    return;
  }
  bar.classList.add("fade-out");
  cancelBarFadeTimer = setTimeout(() => {
    cancelBarFadeTimer = null;
    pendingCancel = null;
    bar.classList.remove("fade-out");
    bar.classList.add("hidden");
  }, HANG_BAR_FADE_MS);
}

function ensureCancelBar() {
  let bar = document.getElementById("cancel-bar");
  if (bar && bar.parentNode === document.body) {
    wireCancelBarButtons();
    return bar;
  }
  if (bar && bar.parentNode !== document.body) {
    bar.remove();
  }
  bar = document.createElement("div");
  bar.id = "cancel-bar";
  bar.className = "hang-bar cancel-pop hidden";
  bar.innerHTML = `
    <span id="cancel-bar-text"></span>
    <button type="button" id="cancel-confirm" class="hang-btn confirm">确认</button>
    <button type="button" id="cancel-dismiss" class="hang-btn cancel">取消</button>`;
  document.body.appendChild(bar);
  wireCancelBarButtons();
  return bar;
}

function wireCancelBarButtons() {
  const confirmBtn = document.getElementById("cancel-confirm");
  const dismissBtn = document.getElementById("cancel-dismiss");
  if (confirmBtn && !confirmBtn.dataset.wired) {
    confirmBtn.dataset.wired = "1";
    confirmBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      submitCancel().catch(() => {});
    });
  }
  if (dismissBtn && !dismissBtn.dataset.wired) {
    dismissBtn.dataset.wired = "1";
    dismissBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      hideCancelBar();
    });
  }
}

function showCancelBar(info, point) {
  hideHangBar();
  pendingCancel = info;
  const bar = ensureCancelBar();
  const text = document.getElementById("cancel-bar-text");
  if (!bar || !text) return;
  const label = info.side === "sell" ? "卖挂" : "买挂";
  const confirmBtn = document.getElementById("cancel-confirm");
  if (confirmBtn) confirmBtn.hidden = Boolean(info.request);
  if (info.request) {
    text.textContent = `待执行 ${label} ${Number(info.price).toFixed(3)} × ${info.qty}`;
  } else {
    text.textContent = `撤 ${label} ${Number(info.price).toFixed(3)} × ${info.qty}`;
  }
  if (cancelBarFadeTimer) {
    clearTimeout(cancelBarFadeTimer);
    cancelBarFadeTimer = null;
  }
  bar.classList.remove("hidden", "fade-out");
  bar.classList.add("cancel-pop");
  bar.classList.toggle("buy", info.side === "buy");
  bar.classList.toggle("sell", info.side === "sell");
  const x = point && Number.isFinite(point.x) ? point.x : window.innerWidth / 2;
  const y = point && Number.isFinite(point.y) ? point.y : window.innerHeight / 2;
  placeHangBar(bar, x, y);
  const simActs = [];
  if (isSimMode()) {
    if (info.request) {
      simActs.push({
        label: "推进至已报",
        run: () => simAdvanceToLive(info),
      });
    }
    simActs.push({
      label: info.side === "sell" ? "推进至卖成" : "推进至买成",
      run: () => simAdvanceToFill(info),
    });
    if (!info.request) {
      simActs.push({
        label: "推进至已撤",
        run: () => simAdvanceToCancel(info),
      });
    }
  }
  setSimBarActions(bar, simActs);
  if (cancelBarTimer) clearTimeout(cancelBarTimer);
  cancelBarTimer = setTimeout(() => {
    cancelBarTimer = null;
    hideCancelBar({ fade: true });
  }, HANG_BAR_IDLE_MS);
}

function onHangTagClick(tag, point) {
  if (!getLastGoodData() || cancelSubmitting) return;
  const request = tag.classList.contains("request");
  if (request && !isSimMode()) return;
  const orderId = String(tag.dataset.orderId || "");
  if (!orderId) return;
  if (tag.classList.contains("canceling")) {
    setMeta("该挂单已有撤单请求");
    return;
  }
  const row = tag.closest(".ladder-row[data-idx]");
  const idx = Number(row && row.dataset.idx);
  const price = Number.isFinite(idx) ? idxToPrice(idx, TICK) : 0;
  showCancelBar(
    {
      orderId,
      side: tag.dataset.side === "sell" ? "sell" : "buy",
      qty: num(tag.dataset.qty),
      price,
      request,
    },
    point
  );
}

async function submitCancel() {
  if (!pendingCancel || !getLastGoodData() || cancelSubmitting) return;
  const info = pendingCancel;
  cancelSubmitting = true;
  try {
    const res = await fetch("/api/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetOrderId: info.orderId,
        side: info.side,
        price: info.price,
        qty: info.qty,
        stock: getLastGoodData().stock,
        account: getLastGoodData().account,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    setMeta(`撤单请求已写入 #${data.order.id}（待策略执行）`);
    hideCancelBar();
    const next = {
      id: data.order.id,
      targetOrderId: String(data.order.target_order_id || info.orderId),
      side: info.side,
      price: info.price,
      qty: info.qty,
      status: data.order.status || "pending",
      action: "cancel",
    };
    const prev = getLastGoodData().pendingCancels || [];
    if (!prev.some((x) => String(x.targetOrderId || x.target_order_id) === String(next.targetOrderId))) {
      getLastGoodData().pendingCancels = prev.concat(next);
    }
    dropCruiseOrder(getLastGoodData().stock, info.orderId);
    renderLadder(buildLevels(getLastGoodData(), tickValue()), tickValue(), getLastGoodData());
  } catch (err) {
    setMeta(`撤单失败: ${err.message}`);
  } finally {
    cancelSubmitting = false;
  }
}

function listSideCancels(data, side) {
  const rows = (data.orders && data.orders.length ? data.orders : data.openOrders) || [];
  const pendingIds = new Set(
    (data.pendingCancels || []).map((row) => String(row.targetOrderId || row.target_order_id || ""))
  );
  const live = [];
  for (const row of rows) {
    if (optSide(row) !== side) continue;
    const remaining = num(row.m_nVolumeTotal);
    if (!OPEN_STATUS.has(statusCode(row)) || !(remaining > 0)) continue;
    const orderId = String(row.order_id || row.m_strOrderSysID || row.m_strOrderRef || "");
    if (!orderId || pendingIds.has(orderId)) continue;
    live.push({
      orderId,
      side,
      price: orderPrice(row),
      qty: remaining,
    });
  }
  const requests = pendingHangRequests(data).filter((row) => (row.side === "sell" ? "sell" : "buy") === side);
  return { live, requests };
}

async function postCancelOne(info) {
  const res = await fetch("/api/cancel", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetOrderId: info.orderId,
      side: info.side,
      price: info.price,
      qty: info.qty,
      stock: getLastGoodData().stock,
      account: getLastGoodData().account,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.order || {};
}

async function dismissPendingHang(row) {
  const id = Number(row.id);
  if (!Number.isFinite(id) || id <= 0) return;
  await fetch(`/api/commands/${id}/result`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: false, error: "用户全撤" }),
  }).catch(() => {});
  const data = getLastGoodData();
  if (!data) return;
  data.pendingHangs = (data.pendingHangs || []).filter((item) => Number(item.id) !== id);
}

let cancelAllBusy = false;

async function cancelAll(side) {
  if (cancelAllBusy || !getLastGoodData()) return;
  if (cruiseOn && !isSimMode()) return;
  const { live, requests } = listSideCancels(getLastGoodData(), side);
  const total = live.length + requests.length;
  const label = side === "sell" ? "卖单" : "买单";
  if (!total) {
    setMeta(`没有可撤的${label}`);
    return;
  }
  if (!window.confirm(`撤销全部${label} ${total} 笔？`)) return;
  cancelAllBusy = true;
  const buttons = document.querySelectorAll(".cancel-all-btn");
  buttons.forEach((btn) => {
    btn.disabled = true;
  });
  let ok = 0;
  let fail = 0;
  try {
    dropCruiseSide(getLastGoodData().stock, side);
    for (const info of live) {
      try {
        if (isSimMode()) {
          await simAdvanceToCancel(info);
        } else {
          const order = await postCancelOne(info);
          const next = {
            id: order.id,
            targetOrderId: String(order.target_order_id || info.orderId),
            side: info.side,
            price: info.price,
            qty: info.qty,
            status: order.status || "pending",
            action: "cancel",
          };
          const prev = getLastGoodData().pendingCancels || [];
          if (!prev.some((row) => String(row.targetOrderId || row.target_order_id) === String(next.targetOrderId))) {
            getLastGoodData().pendingCancels = prev.concat(next);
          }
        }
        ok += 1;
      } catch (_err) {
        fail += 1;
      }
    }
    for (const row of requests) {
      try {
        await dismissPendingHang(row);
        ok += 1;
      } catch (_err) {
        fail += 1;
      }
    }
    const tick = tickValue();
    renderLadder(buildLevels(getLastGoodData(), tick), tick, getLastGoodData());
    setMeta(fail ? `${label}全撤 ${ok} 笔，失败 ${fail} 笔` : `${label}全撤已提交 ${ok} 笔`);
  } finally {
    cancelAllBusy = false;
    buttons.forEach((btn) => {
      btn.disabled = false;
    });
  }
}

function onPriceClick(el, point) {
  hideCancelBar();
  if (hangSubmitting) return;
  const go = () => {
    if (!getLastGoodData()) return;
    const idx = Number(el.dataset.idx);
    if (!Number.isFinite(idx)) return;
    const price = idxToPrice(idx, TICK);
    const bid = num(getLastGoodData().bid1);
    const ask = num(getLastGoodData().ask1);
    const bidIdx = bid > 0 ? priceToIdx(bid, TICK) : null;
    const askIdx = ask > 0 ? priceToIdx(ask, TICK) : null;
    if (bidIdx != null && idx <= bidIdx) {
      showHangBar("buy", price, point);
      return;
    }
    if (askIdx != null && idx >= askIdx) {
      showHangBar("sell", price, point);
      return;
    }
    hideHangBar();
    setMeta("买挂仅限买1及下方，卖挂仅限卖1及上方");
  };
  if (isSimMode() && !getLastGoodData()) {
    ensureSimQuote()
      .then(go)
      .catch((err) => setMeta(`模拟失败: ${err.message}`));
    return;
  }
  if (!getLastGoodData()) return;
  go();
}

async function submitHang() {
  if (!pendingHang || hangSubmitting) return;
  const { side, price } = pendingHang;
  const qty = hangQty();
  hangSubmitting = true;
  try {
    if (!getLastGoodData()) return;
    const res = await fetch("/api/hang", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        side,
        price,
        qty,
        stock: getLastGoodData().stock,
        account: getLastGoodData().account,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    const label = side === "buy" ? "买挂" : "卖挂";
    setMeta(`${label}请求已写入 #${data.order.id}：${price.toFixed(3)} × ${qty}（待策略执行）`);
    hideHangBar();
    if (getLastGoodData()) {
      const next = {
        id: data.order.id,
        account: data.order.account,
        stock: data.order.stock,
        side: data.order.side,
        price: Number(data.order.price),
        qty: Number(data.order.qty),
        status: data.order.status || "pending",
      };
      const prev = getLastGoodData().pendingHangs || [];
      if (!prev.some((x) => Number(x.id) === Number(next.id))) {
        getLastGoodData().pendingHangs = prev.concat(next);
      }
      renderLadder(buildLevels(getLastGoodData(), tickValue()), tickValue(), getLastGoodData());
    }
  } catch (err) {
    setMeta(`挂单失败: ${err.message}`);
  } finally {
    hangSubmitting = false;
  }
}

function isUsableState(data) {
  if (!data || data.updatedAt == null || data.updatedAt === "") return false;
  const n =
    (data.openOrders || []).length +
    (data.orders || []).length +
    (data.deals || []).length;
  return (
    n > 0 ||
    num(data.bid1) > 0 ||
    num(data.ask1) > 0 ||
    num(data.preClose) > 0 ||
    num(data.lastClose) > 0 ||
    num(data.lastPrice) > 0
  );
}

function dealKey(row) {
  const tid = String(row.m_strTradeID || row.trade_id || row.m_strDealID || row.m_strExecID || "");
  if (tid) return `t:${tid}`;
  const oid = String(row.order_id || row.m_strOrderSysID || "");
  const t = String(row.m_strTradeTime || row.time || "");
  return `o:${oid}:${t}:${dealPrice(row)}:${num(row.m_nVolume || row.qty)}`;
}

function pushAlert(text) {
  const root = document.getElementById("alerts");
  if (!root) return;
  const el = document.createElement("div");
  el.className = "alert";
  const msg = document.createElement("span");
  msg.textContent = text;
  const close = document.createElement("button");
  close.type = "button";
  close.setAttribute("aria-label", "关闭");
  close.textContent = "×";
  close.addEventListener("click", () => el.remove());
  el.append(msg, close);
  root.appendChild(el);
}

function noteCruiseFails(list, stock) {
  const book = cruiseBook(stock);
  if (!book.on) return;
  Promise.resolve()
    .then(async () => {
      for (const row of list || []) {
        if (row.source && row.source !== "cruise") continue;
        const id = String(row.id);
        if (book.seenFails.has(id)) continue;
        const claimed = await claimCruiseKey("fail", id, stock);
        book.seenFails.add(id);
        if (!claimed) continue;
        const label = row.side === "sell" ? "卖挂" : "买挂";
        pushAlert(`${stockProfile(stock).label} ${label}失败 ${Number(row.price).toFixed(3)} × ${row.qty}：${row.errorMessage || "执行失败"}`);
      }
    })
    .catch(() => {});
}

function cruiseChannel() {
  return isSimMode() ? "sim" : "live";
}

function cruiseQuery(stock) {
  return `channel=${encodeURIComponent(cruiseChannel())}&stock=${encodeURIComponent(normalizeStockId(stock || selectedStock()))}`;
}

function cruiseBody(extra, stock) {
  return { channel: cruiseChannel(), stock: normalizeStockId(stock || selectedStock()), ...extra };
}

function paintCruise(on) {
  cruiseOn = on;
  const book = cruiseBook(selectedStock());
  book.on = on;
  document.body.classList.toggle("cruise-on", on);
  const btn = document.getElementById("cruise-btn");
  if (btn) {
    btn.textContent = on ? "退出巡航" : "巡航";
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }
  const qty = document.getElementById("hang-qty");
  if (qty) qty.disabled = on && !isSimMode();
  const locked = on && !isSimMode();
  document.querySelectorAll(".cancel-all-btn").forEach((el) => {
    el.disabled = locked;
  });
  paintStockSwitch();
}

function applyCruiseFromServer(state, stock) {
  if (!state) return;
  const id = normalizeStockId(stock || selectedStock());
  const book = cruiseBook(id);
  const on = Boolean(state.on);
  book.on = on;
  book.seenDeals = new Set((state.seenDeals || []).map(String));
  book.seenFails = new Set((state.seenFails || []).map(String));
  if (Array.isArray(state.rungs)) book.rungs = state.rungs;
  book.dropped = new Set((state.dropped || []).map(String));
  book.lastDeal = normalizeSavedDeal(state.lastDeal);
  book.prevDeal = normalizeSavedDeal(state.prevDeal);
  book.loaded = true;
  book.rungsSig = rungsSignature(book.rungs, book.dropped, book.lastDeal, book.prevDeal);
  if (id !== selectedStock()) {
    paintStockSwitch();
    return;
  }
  const was = cruiseOn;
  paintCruise(on);
  if (on && !was) {
    const locked = on && !isSimMode();
    if (locked) {
      hideHangBar();
      hideCancelBar();
    }
  }
}

async function fetchCruiseState(stock) {
  const res = await fetch(`/api/cruise?${cruiseQuery(stock)}`, {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return data && data.ok ? data : null;
}

async function syncCruiseFromServer() {
  const state = await fetchCruiseState(selectedStock());
  if (state) applyCruiseFromServer(state, selectedStock());
}

async function syncAllCruiseFlags() {
  await Promise.all(
    STOCKS.map(async (s) => {
      const state = await fetchCruiseState(s.id);
      if (state) applyCruiseFromServer(state, s.id);
    })
  );
}

async function restoreCruise() {
  localStorage.removeItem("qmt_cruise");
  localStorage.removeItem("qmt_cruise_deals");
  localStorage.removeItem("qmt_cruise_fails");
  await syncAllCruiseFlags();
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
  const orderRows = (data && data.orders && data.orders.length ? data.orders : data && data.openOrders) || [];
  for (const row of orderRows) {
    const side = optSide(row) || "buy";
    const remaining = num(row.m_nVolumeTotal);
    if (!OPEN_STATUS.has(statusCode(row)) || !(remaining > 0)) continue;
    const idx = priceToIdx(orderPrice(row), TICK);
    const map = side === "sell" ? sell : buy;
    map.set(idx, (map.get(idx) || 0) + remaining);
  }
  return { buy, sell };
}

function cruiseEnableError(data) {
  if (!data) return "暂无行情与挂单，禁止巡航";
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
    const needTicks = Math.round(stockProfile(data && data.stock).minSpread * tickScale(TICK));
    if (spreadTicks < needTicks) {
      const spread = spreadTicks / tickScale(TICK);
      const need = stockProfile(data && data.stock).minSpread;
      return `最高买挂与卖挂价差 ${spread.toFixed(3)} < ${need.toFixed(3)}，禁止巡航`;
    }
  }
  return "";
}

function cruiseAnchorIdx(data, maps) {
  const profile = stockProfile(data && data.stock);
  const { buy, sell } = maps || liveHangQtyMaps(data);
  const gapTicks = Math.round(profile.minSpread * tickScale(TICK));
  const bidIdx = num(data.bid1) > 0 ? priceToIdx(data.bid1, TICK) : 0;
  const askIdx = num(data.ask1) > 0 ? priceToIdx(data.ask1, TICK) : 0;
  let sellCruise = sell.size ? Math.min(...sell.keys()) : 0;
  if (!sellCruise && askIdx > 0) sellCruise = askIdx;
  let buyCruise = sellCruise ? sellCruise - gapTicks : 0;
  if (bidIdx > 0) buyCruise = buyCruise ? Math.min(buyCruise, bidIdx) : bidIdx;
  return { buy, sell, buyCruise, sellCruise, profile };
}

function cruiseFillPlans(data, opts) {
  const maps = hangMapsWithPending(data);
  const { buy, sell, buyCruise, sellCruise, profile } = cruiseAnchorIdx(data, maps);
  const target = hangQty(data && data.stock);
  const buyStep = Math.max(1, Math.round(profile.buyStep * tickScale(TICK)));
  const sellStep = Math.max(1, Math.round(profile.sellStep * tickScale(TICK)));
  const want = new Set((opts && opts.sides) || ["buy", "sell"]);
  const plans = [];
  function addSide(side, startIdx, dir, have) {
    if (!(startIdx > 0)) return;
    for (let i = 0; i < profile.levels; i++) {
      const idx = startIdx + dir * i;
      const need = target - (have.get(idx) || 0);
      if (need <= 0) continue;
      const qty = Math.floor(need / 100) * 100;
      if (qty > 0) plans.push({ side, price: idxToPrice(idx, TICK), qty, coverQty: target });
    }
  }
  if (want.has("buy")) addSide("buy", buyCruise, -buyStep, buy);
  if (want.has("sell")) addSide("sell", sellCruise, sellStep, sell);
  return plans;
}

function hangMapsWithPending(data) {
  const { buy, sell } = liveHangQtyMaps(data);
  for (const row of pendingHangRequests(data)) {
    const idx = priceToIdx(num(row.price), TICK);
    const map = row.side === "sell" ? sell : buy;
    map.set(idx, (map.get(idx) || 0) + num(row.qty));
  }
  return { buy, sell };
}

function cruiseBasePrice(data, row) {
  const oid = String(row.order_id || row.m_strOrderSysID || row.m_strOrderRef || "");
  const orderRows = (data && data.orders && data.orders.length ? data.orders : data && data.openOrders) || [];
  if (oid) {
    for (const order of orderRows) {
      const id = String(order.order_id || order.m_strOrderSysID || order.m_strOrderRef || "");
      if (id && id === oid) {
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
  if (sa === "sell") return pa - pb;
  return pb - pa;
}

function roundTickPx(px) {
  const scale = tickScale(TICK);
  return Math.round(num(px) * scale) / scale;
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

function rememberPendingHang(order, fallback) {
  if (!order || !order.id) return;
  const next = {
    id: order.id,
    account: order.account,
    stock: order.stock,
    side: order.side || fallback.side,
    price: Number(order.price),
    qty: Number(order.qty),
    status: order.status || "pending",
    source: order.source || fallback.source || "",
  };
  const stock = normalizeStockId(next.stock || (fallback && fallback.stock) || selectedStock());
  const ns = stockNs(stock);
  const target = ns.data;
  if (!target) return;
  const prev = target.pendingHangs || [];
  if (!prev.some((x) => Number(x.id) === Number(next.id))) {
    target.pendingHangs = prev.concat(next);
  }
  ns.data = target;
  if (stock === selectedStock()) {
    renderLadder(buildLevels(target, tickValue()), tickValue(), target);
  }
}

async function postHangOrder({ side, price, qty, stock, account, source, coverQty }) {
  const res = await fetch("/api/hang", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ side, price, qty, stock, account, source, coverQty }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
  if (body.covered) return { covered: true };
  return body.order || {};
}

async function renewCruiseLease(stock) {
  const res = await fetch("/api/cruise/lease", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cruiseBody({ holder: cruiseHolder }, stock)),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) return { held: false, reason: "missing" };
  return { held: Boolean(data.held), reason: data.reason || "" };
}

function releaseCruiseLease(stock) {
  const body = JSON.stringify(cruiseBody({ holder: cruiseHolder }, stock));
  if (navigator.sendBeacon) {
    navigator.sendBeacon("/api/cruise/lease/release", new Blob([body], { type: "application/json" }));
    return;
  }
  fetch("/api/cruise/lease/release", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {});
}

async function postCruiseState(on) {
  const res = await fetch("/api/cruise", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cruiseBody({ on })),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  applyCruiseFromServer(data, selectedStock());
}

async function setCruise(on) {
  const book = cruiseBook(selectedStock());
  if (book.busy) return;
  if (on) {
    const reason = cruiseEnableError(getLastGoodData());
    if (reason) {
      pushAlert(reason);
      window.alert(reason);
      return;
    }
  }
  book.busy = true;
  try {
    if (on) {
      const plans = cruiseFillPlans(getLastGoodData());
      for (const plan of plans) {
        const label = plan.side === "sell" ? "卖挂" : "买挂";
        try {
          const lease = await renewCruiseLease(selectedStock());
          if (!lease.held && lease.reason === "busy") break;
          const order = await postHangOrder({
            ...plan,
            stock: getLastGoodData().stock,
            account: getLastGoodData().account,
            source: "cruise",
          });
          if (order && order.covered) continue;
          rememberPendingHang(order, { ...plan, source: "cruise" });
        } catch (err) {
          const reason = `巡航补单失败：${label} ${plan.price.toFixed(3)} × ${plan.qty}：${err.message}`;
          pushAlert(reason);
          window.alert(reason);
          return;
        }
      }
    }
    await postCruiseState(on);
    if (on) await renewCruiseLease(selectedStock());
    else releaseCruiseLease(selectedStock());
  } catch (err) {
    const reason = `巡航同步失败：${err.message}`;
    pushAlert(reason);
    if (on) window.alert(reason);
  } finally {
    book.busy = false;
  }
}

async function claimCruiseKey(kind, key, stock) {
  const res = await fetch("/api/cruise/claim", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cruiseBody({ kind, key }, stock)),
  });
  const data = await res.json().catch(() => ({}));
  return Boolean(data.claimed);
}

async function unclaimCruiseKey(kind, key, stock) {
  await fetch("/api/cruise/unclaim", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cruiseBody({ kind, key }, stock)),
  }).catch(() => {});
}

async function placeCruisePlans(data, plans, failPrefix) {
  const prefix = failPrefix || "巡航补档失败";
  for (const plan of plans) {
    const lease = await renewCruiseLease(data.stock);
    if (!lease.held) return;
    const label = plan.side === "sell" ? "卖挂" : "买挂";
    try {
      const order = await postHangOrder({
        ...plan,
        stock: data.stock,
        account: data.account,
        source: "cruise",
      });
      if (order && order.covered) continue;
      rememberPendingHang(order, { ...plan, stock: data.stock, source: "cruise" });
    } catch (err) {
      pushAlert(`${prefix}：${label} ${plan.price.toFixed(3)} × ${plan.qty}：${err.message}`);
    }
  }
}

async function maintainCruiseRungs(data) {
  if (!data) return;
  const book = cruiseBook(data.stock);
  if ((book.rungs || []).length && !liveOpenRungs(data, book.dropped).length) return;
  const { sell } = hangMapsWithPending(data);
  const plans = cruiseFillPlans(data, { sides: ["buy"] });
  if (!sell.size) plans.push(...cruiseFillPlans(data, { sides: ["sell"] }));
  if (!plans.length) return;
  await placeCruisePlans(data, plans);
}

function orderRowId(row) {
  return String((row && (row.order_id || row.m_strOrderSysID || row.m_strOrderRef)) || "");
}

function rungsSignature(rungs, dropped, lastDeal, prevDeal) {
  const body = (rungs || []).map((r) => `${r.side}:${r.price}:${r.qty}:${r.orderId || ""}`).join("|");
  const drop = [...(dropped || [])].map(String).sort().join(",");
  const deal = (row) => (row ? `${row.side}:${row.price}:${row.date}:${row.rank}` : "");
  return `${body}#${drop}#${deal(lastDeal)}#${deal(prevDeal)}`;
}

function liveOpenRungs(data, dropped) {
  const rows = (data && data.orders && data.orders.length ? data.orders : (data && data.openOrders) || []);
  const skip = dropped || new Set();
  const out = [];
  for (const row of rows) {
    const side = optSide(row);
    if (side !== "buy" && side !== "sell") continue;
    const remaining = num(row.m_nVolumeTotal);
    if (!OPEN_STATUS.has(statusCode(row)) || !(remaining > 0)) continue;
    const orderId = orderRowId(row);
    if (orderId && skip.has(orderId)) continue;
    const qty = Math.floor(remaining / 100) * 100;
    const price = roundTickPx(orderPrice(row));
    if (!(price > 0) || !(qty > 0)) continue;
    out.push({ side, price, qty, orderId });
  }
  return out;
}

async function persistCruiseRungs(stock) {
  const book = cruiseBook(stock);
  if (!book.loaded) return;
  const sig = rungsSignature(book.rungs, book.dropped, book.lastDeal, book.prevDeal);
  if (sig === book.rungsSig) return;
  const res = await fetch("/api/cruise/rungs", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cruiseBody({
      rungs: book.rungs,
      dropped: [...book.dropped],
      lastDeal: book.lastDeal,
      prevDeal: book.prevDeal,
    }, stock)),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) return;
  book.rungsSig = sig;
}

function rememberLiveCruiseRungs(data) {
  if (!data) return;
  const stock = normalizeStockId(data.stock || selectedStock());
  const book = cruiseBook(stock);
  if (!book.on) return;
  const live = liveOpenRungs(data, book.dropped);
  if (!live.length) return;
  book.rungs = live;
  persistCruiseRungs(stock).catch(() => {});
}

function dropCruiseOrder(stock, orderId) {
  const id = String(orderId || "");
  if (!id) return;
  const book = cruiseBook(stock);
  book.dropped.add(id);
  book.rungs = (book.rungs || []).filter((rung) => rung.orderId !== id);
  persistCruiseRungs(stock).catch(() => {});
}

function dropCruiseSide(stock, side) {
  const book = cruiseBook(stock);
  for (const rung of book.rungs || []) {
    if (rung.side === side && rung.orderId) book.dropped.add(rung.orderId);
  }
  book.rungs = (book.rungs || []).filter((rung) => rung.side !== side);
  persistCruiseRungs(stock).catch(() => {});
}

function resumeCruisePlans(data) {
  const stock = normalizeStockId(data.stock || selectedStock());
  const book = cruiseBook(stock);
  const saved = book.rungs || [];
  if (!book.on || !saved.length || !Array.isArray(data.orders)) return [];
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
  const plans = [];
  for (const rung of saved) {
    if (rung.orderId && book.dropped.has(rung.orderId)) continue;
    const idx = priceToIdx(rung.price, TICK);
    const have = (rung.side === "sell" ? covered.sell : covered.buy).get(idx) || 0;
    if (have >= rung.qty) continue;
    const row = rung.orderId ? byId.get(rung.orderId) : null;
    if (row && OPEN_STATUS.has(statusCode(row)) && num(row.m_nVolumeTotal) > 0) continue;
    if (row && statusCode(row) === 56) continue;
    const cancelled = row && CANCEL_STATUS.has(statusCode(row));
    const rolledOff = !row && !anyStillOpen;
    if (!cancelled && !rolledOff) continue;
    const askIdx = num(data.ask1) > 0 ? priceToIdx(data.ask1, TICK) : 0;
    const bidIdx = num(data.bid1) > 0 ? priceToIdx(data.bid1, TICK) : 0;
    if (rung.side === "sell" && askIdx > 0 && idx < askIdx) continue;
    if (rung.side === "buy" && bidIdx > 0 && idx > bidIdx) continue;
    const qty = Math.floor((rung.qty - have) / 100) * 100;
    if (qty > 0) plans.push({ side: rung.side, price: rung.price, qty, coverQty: rung.qty });
  }
  return plans;
}

function cruiseLadderIdxs(data, side) {
  const maps = hangMapsWithPending(data);
  const live = side === "sell" ? maps.sell : maps.buy;
  if (live.size) return [...live.keys()];
  const book = cruiseBook(data && data.stock);
  const idxs = [];
  for (const rung of book.rungs || []) {
    if (rung.side !== side) continue;
    if (rung.orderId && book.dropped.has(rung.orderId)) continue;
    const idx = priceToIdx(rung.price, TICK);
    if (idx > 0) idxs.push(idx);
  }
  return idxs;
}

function pushCruiseGap(plans, side, idx, have, target) {
  const qty = Math.floor((target - (have.get(idx) || 0)) / 100) * 100;
  if (qty > 0) plans.push({ side, price: idxToPrice(idx, TICK), qty, coverQty: target });
}

function cruiseGapPlans(data) {
  if (!data) return [];
  const stock = normalizeStockId(data.stock || selectedStock());
  const book = cruiseBook(stock);
  const profile = stockProfile(stock);
  const maps = hangMapsWithPending(data);
  const target = hangQty(stock);
  const buyStep = Math.max(1, Math.round(profile.buyStep * tickScale(TICK)));
  const sellStep = Math.max(1, Math.round(profile.sellStep * tickScale(TICK)));
  const levels = profile.levels;
  const askIdx = num(data.ask1) > 0 ? priceToIdx(data.ask1, TICK) : 0;
  const bidIdx = num(data.bid1) > 0 ? priceToIdx(data.bid1, TICK) : 0;
  const plans = [];

  const sellIdxs = cruiseLadderIdxs(data, "sell");
  const sellHigh = sellIdxs.length ? Math.max(...sellIdxs) : 0;
  if (askIdx > 0 && sellHigh > 0 && askIdx > sellHigh) {
    book.sellGapFrom = askIdx;
    book.sellGapTop = askIdx + levels * sellStep;
  } else if (book.sellGapFrom && askIdx > book.sellGapFrom) {
    book.sellGapFrom = askIdx;
    book.sellGapTop = askIdx + levels * sellStep;
  }
  if (book.sellGapFrom && book.sellGapTop) {
    const before = plans.length;
    for (let idx = book.sellGapFrom; idx <= book.sellGapTop; idx += sellStep) {
      pushCruiseGap(plans, "sell", idx, maps.sell, target);
    }
    if (plans.length === before) {
      book.sellGapFrom = 0;
      book.sellGapTop = 0;
    } else {
      const sig = `sell:${book.sellGapFrom}:${book.sellGapTop}`;
      if (book.gapNoteSell !== sig) {
        book.gapNoteSell = sig;
        const fromPx = idxToPrice(book.sellGapFrom, TICK);
        const toPx = idxToPrice(book.sellGapTop, TICK);
        pushAlert(`${profile.label} 卖一 ${fromPx.toFixed(3)} 击穿卖挂，卖挂从 ${fromPx.toFixed(3)} 补到 ${toPx.toFixed(3)}`);
      }
    }
  }

  const buyIdxs = cruiseLadderIdxs(data, "buy");
  const buyLow = buyIdxs.length ? Math.min(...buyIdxs) : 0;
  if (bidIdx > 0 && buyLow > 0 && bidIdx < buyLow) {
    book.buyGapFrom = bidIdx;
    book.buyGapLow = bidIdx - levels * buyStep;
  } else if (book.buyGapFrom && bidIdx > 0 && bidIdx < book.buyGapFrom) {
    book.buyGapFrom = bidIdx;
    book.buyGapLow = bidIdx - levels * buyStep;
  }
  if (book.buyGapFrom && book.buyGapLow) {
    const before = plans.length;
    for (let idx = book.buyGapFrom; idx >= book.buyGapLow && idx > 0; idx -= buyStep) {
      pushCruiseGap(plans, "buy", idx, maps.buy, target);
    }
    if (plans.length === before) {
      book.buyGapFrom = 0;
      book.buyGapLow = 0;
    } else {
      const sig = `buy:${book.buyGapFrom}:${book.buyGapLow}`;
      if (book.gapNoteBuy !== sig) {
        book.gapNoteBuy = sig;
        const fromPx = idxToPrice(book.buyGapFrom, TICK);
        const toPx = idxToPrice(book.buyGapLow, TICK);
        pushAlert(`${profile.label} 买一 ${fromPx.toFixed(3)} 击穿买挂，买挂从 ${fromPx.toFixed(3)} 补到 ${toPx.toFixed(3)}`);
      }
    }
  }
  return plans;
}

function shanghaiTodayDigits() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return parts.replace(/\D/g, "");
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

function rememberSessionDeals(data) {
  if (!data) return;
  const stock = normalizeStockId(data.stock || selectedStock());
  const book = cruiseBook(stock);
  if (!book.loaded) return;
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
  const before = rungsSignature(book.rungs, book.dropped, book.lastDeal, book.prevDeal);
  book.lastDeal = latest;
  book.prevDeal = prev;
  if (rungsSignature(book.rungs, book.dropped, book.lastDeal, book.prevDeal) !== before) {
    persistCruiseRungs(stock).catch(() => {});
  }
}

function yesterdayLastDeal(data, book) {
  const today = shanghaiTodayDigits();
  let best = null;
  for (const row of (data && data.deals) || []) {
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

function seedCruisePlans(data) {
  const stock = normalizeStockId(data.stock || selectedStock());
  const book = cruiseBook(stock);
  if (!book.on || (book.rungs || []).length) return [];
  if (liveOpenRungs(data, book.dropped).length) return [];
  const deal = yesterdayLastDeal(data, book);
  if (!deal) return [];
  const profile = stockProfile(stock);
  const step = deal.side === "sell" ? profile.sellStep : profile.reverseGap;
  const sellPx = roundTickPx(deal.price + step);
  const sellIdx = priceToIdx(sellPx, TICK);
  if (!(sellIdx > 0)) return [];
  const gapTicks = Math.round(profile.minSpread * tickScale(TICK));
  const buyIdx = sellIdx - gapTicks;
  const target = hangQty(stock);
  const covered = hangMapsWithPending(data);
  const buyStep = Math.max(1, Math.round(profile.buyStep * tickScale(TICK)));
  const sellStep = Math.max(1, Math.round(profile.sellStep * tickScale(TICK)));
  const plans = [];
  function add(side, start, dir, have) {
    if (!(start > 0)) return;
    for (let i = 0; i < profile.levels; i += 1) {
      const idx = start + dir * i;
      const qty = Math.floor((target - (have.get(idx) || 0)) / 100) * 100;
      if (qty > 0) plans.push({ side, price: idxToPrice(idx, TICK), qty, coverQty: target });
    }
  }
  add("sell", sellIdx, sellStep, covered.sell);
  add("buy", buyIdx, -buyStep, covered.buy);
  const note = `${deal.date}:${deal.side}:${deal.price}`;
  if (plans.length && book.seedNote !== note) {
    book.seedNote = note;
    const verb = deal.side === "sell" ? "卖成" : "买成";
    pushAlert(`${profile.label} 无续航档位，按昨日最后一笔${verb} ${deal.price.toFixed(3)}，卖挂从 ${sellPx.toFixed(3)} 开始`);
  }
  return plans;
}

function cruiseReversePlan(data, row) {
  const side = optSide(row);
  if (side !== "buy" && side !== "sell") return null;
  const basePx = cruiseBasePrice(data, row);
  const qty = Math.round(num(row.m_nVolume || row.qty));
  if (!(basePx > 0) || !(qty > 0)) return null;
  const nextSide = side === "sell" ? "buy" : "sell";
  const gap = stockProfile(data && data.stock).reverseGap;
  const rawPx = roundTickPx(basePx + (side === "sell" ? -gap : gap));
  const nextPx = clampCruiseHangPx(nextSide, rawPx, data);
  return { side: nextSide, price: nextPx, qty };
}

async function cruiseTick(data) {
  if (!data) return;
  const stock = normalizeStockId(data.stock || selectedStock());
  const book = cruiseBook(stock);
  if (!book.loaded) return;
  rememberSessionDeals(data);
  if (!book.on) return;
  const lease = await renewCruiseLease(stock);
  if (!lease.held || book.busy) return;
  noteCruiseFails(data.failedHangs, stock);
  rememberSessionDeals(data);
  rememberLiveCruiseRungs(data);
  const resumePlans = resumeCruisePlans(data);
  const seedPlans = resumePlans.length ? [] : seedCruisePlans(data);
  const deals = Array.isArray(data.deals) ? data.deals : [];
  const fresh = [];
  for (const row of deals) {
    const key = dealKey(row);
    if (!key || book.seenDeals.has(key)) continue;
    fresh.push({ row, key });
  }
  fresh.sort((a, b) => compareCruiseDeals(data, a.row, b.row));
  const buyTopUp = cruiseFillPlans(data, { sides: ["buy"] });
  const gapPlans = cruiseGapPlans(data);
  if (!fresh.length && !buyTopUp.length && !resumePlans.length && !seedPlans.length && !gapPlans.length) return;
  book.busy = true;
  try {
    const merged = new Map();
    for (const { row, key } of fresh) {
      const claimed = await claimCruiseKey("deal", key, stock);
      if (!claimed) {
        book.seenDeals.add(key);
        continue;
      }
      const plan = cruiseReversePlan(data, row);
      if (!plan) {
        book.seenDeals.add(key);
        continue;
      }
      const slot = `${plan.side}:${priceToIdx(plan.price, TICK)}`;
      const cur = merged.get(slot);
      if (cur) {
        cur.qty += plan.qty;
        cur.keys.push(key);
      } else {
        merged.set(slot, { side: plan.side, price: plan.price, qty: plan.qty, keys: [key] });
      }
    }

    for (const plan of merged.values()) {
      const qty = Math.floor(plan.qty / 100) * 100;
      const label = plan.side === "sell" ? "卖挂" : "买挂";
      if (!(qty > 0)) {
        for (const key of plan.keys) book.seenDeals.add(key);
        continue;
      }
      try {
        const still = await renewCruiseLease(stock);
        if (!still.held) break;
        const order = await postHangOrder({
          side: plan.side,
          price: plan.price,
          qty,
          stock: data.stock || stock,
          account: data.account,
          source: "cruise",
        });
        if (order && order.covered) {
          for (const key of plan.keys) book.seenDeals.add(key);
          continue;
        }
        rememberPendingHang(order, { side: plan.side, stock: data.stock || stock, source: "cruise" });
        for (const key of plan.keys) book.seenDeals.add(key);
      } catch (err) {
        pushAlert(`${stockProfile(stock).label} ${label}失败 ${plan.price.toFixed(3)} × ${qty}：${err.message}`);
        if (isRetryableHangError(err.message)) {
          for (const key of plan.keys) await unclaimCruiseKey("deal", key, stock);
        } else {
          for (const key of plan.keys) book.seenDeals.add(key);
        }
      }
    }
    if (gapPlans.length) await placeCruisePlans(data, gapPlans, "跳空补档");
    if (resumePlans.length) await placeCruisePlans(data, resumePlans, "跨天续航");
    if (seedPlans.length) await placeCruisePlans(data, seedPlans, "按昨日成交续航");
    await maintainCruiseRungs(stockNs(stock).data || data);
  } finally {
    book.busy = false;
  }
}

async function cruiseOtherStocks() {
  for (const s of STOCKS) {
    if (s.id === selectedStock()) continue;
    const state = await fetchCruiseState(s.id);
    if (state) applyCruiseFromServer(state, s.id);
    if (!state || !state.on) continue;
    try {
      const res = await fetch(`/api/state?since=${sinceForStock(s.id)}&stock=${encodeURIComponent(s.id)}`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data.unchanged) {
        const cached = stockNs(s.id).data;
        if (cached) await cruiseTick(cached);
        continue;
      }
      if (!isUsableState(data) && !(data.pendingHangs || []).length) continue;
      stockNs(s.id).data = data;
      stockNs(s.id).version = Number(data.version) || stockNs(s.id).version;
      await cruiseTick(data);
    } catch (_err) {}
  }
}

async function refresh(expectedEpoch) {
  const epoch = expectedEpoch == null ? viewEpoch : expectedEpoch;
  if (expectedEpoch == null && refreshing) return;
  refreshing = true;
  const stock = selectedStock();
  const ns = stockNs(stock);
  try {
    const res = await fetch(`/api/state?since=${sinceForStock(stock)}&stock=${encodeURIComponent(stock)}`, {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (res.status === 401) {
      location.replace("/login.html");
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (epoch !== viewEpoch || selectedStock() !== stock) return;
    syncAllCruiseFlags().catch(() => {});
    const tick = tickValue();

    if (data.unchanged) {
      ns.emptyStreak = 0;
      rememberVersion(data.version, stock);
      if (data.updatedAt != null) setLatestSync(data.updatedAt);
      if (ns.data && (Array.isArray(data.pendingHangs) || Array.isArray(data.pendingCancels))) {
        if (Array.isArray(data.pendingHangs)) ns.data.pendingHangs = data.pendingHangs;
        if (Array.isArray(data.pendingCancels)) ns.data.pendingCancels = data.pendingCancels;
        renderLadder(buildLevels(ns.data, tick), tick, ns.data);
      }
      cruiseTick(ns.data || { ...data, stock }).catch(() => {});
      cruiseOtherStocks().catch(() => {});
      return;
    }

    rememberVersion(data.version, stock);

    if (!isUsableState(data)) {
      ns.emptyStreak += 1;
      if (ns.data) {
        if (ns.emptyStreak >= 3) setMeta("同步中断或暂无数据，仍显示上一帧");
        return;
      }
      if (ns.emptyStreak >= 2) {
        setLatestSync("");
        setMeta(`${stockProfile(stock).label} 尚未收到 QMT 推送`);
        const root = document.getElementById("ladder");
        if (!root.querySelector(".ladder-row[data-idx]") && ns.ladderKey !== "empty") {
          root.innerHTML = '<div class="ladder-row empty"><span class="price">暂无数据</span></div>';
          ns.ladderKey = "empty";
        }
      }
      return;
    }

    ns.emptyStreak = 0;
    data.stock = normalizeStockId(data.stock || stock);
    setLastGoodData(data);
    paintStateMeta(data, stock);
    renderLadder(buildLevels(data, tick), tick, data);
    cruiseTick(data).catch(() => {});
    cruiseOtherStocks().catch(() => {});
  } catch (err) {
    if (epoch !== viewEpoch) return;
    ns.emptyStreak += 1;
    if (!ns.data) setMeta(`拉取失败: ${err.message}`);
    else if (ns.emptyStreak >= 3) setMeta(`拉取失败，仍显示上一帧: ${err.message}`);
  } finally {
    refreshing = false;
  }
}

function paintStockSwitch() {
  const root = document.getElementById("stock-switch");
  if (!root) return;
  const cur = selectedStock();
  let buttons = root.querySelectorAll(".stock-chip");
  if (buttons.length !== STOCKS.length) {
    root.innerHTML = STOCKS.map((s) => (
      `<button type="button" class="stock-chip" data-stock="${s.id}">${s.label}</button>`
    )).join("");
    buttons = root.querySelectorAll(".stock-chip");
  }
  STOCKS.forEach((s, i) => {
    const btn = buttons[i];
    if (!btn) return;
    const active = s.id === cur;
    const cruising = Boolean(cruiseBook(s.id).on);
    btn.classList.toggle("active", active);
    btn.classList.toggle("cruising", cruising);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  });
  document.body.dataset.stock = cur;
  const title = document.getElementById("stock-title");
  if (title) title.textContent = stockHeadline(cur);
}

function wireStockSwitch() {
  const root = document.getElementById("stock-switch");
  if (!root || root.dataset.wired) return;
  root.dataset.wired = "1";
  root.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-stock]");
    if (!btn) return;
    switchStock(btn.dataset.stock).catch((err) => setMeta(`切换失败: ${err.message}`));
  });
}

function paintStateMeta(data, stock) {
  const id = normalizeStockId(stock || (data && data.stock) || selectedStock());
  const open = ((data && data.openOrders) || []).length;
  const orders = ((data && data.orders) || []).length;
  const deals = (data && data.deals) || [];
  let buyFills = 0;
  let sellFills = 0;
  for (const row of deals) {
    if (optSide(row) === "sell") sellFills += 1;
    else buyFills += 1;
  }
  if (data && data.updatedAt != null) setLatestSync(data.updatedAt);
  setMeta(`${stockProfile(id).label}  挂盘${open} 委托${orders} 买成${buyFills} 卖成${sellFills}`);
}

async function switchStock(id) {
  if (cruiseOn && !isSimMode()) return;
  const next = normalizeStockId(id);
  if (next === selectedStock()) return;
  const epoch = ++viewEpoch;
  setSelectedStock(next);
  hideHangBar();
  hideCancelBar();
  pendingHang = null;
  pendingCancel = null;
  lastMetaText = "";
  lastSyncText = "";
  applyHangQtyForStock(next);
  paintCruise(Boolean(cruiseBook(next).on));

  const ns = stockNs(next);
  const ladder = document.getElementById("ladder");
  if (ns.data) {
    ns.ladderKey = "";
    ns.quoteKey = "";
    const tick = tickValue();
    renderLadder(buildLevels(ns.data, tick), tick, ns.data);
    paintStateMeta(ns.data, next);
  } else if (ladder) {
    ladder.innerHTML = `<div class="ladder-row empty"><span class="price">${stockProfile(next).label} 加载中…</span></div>`;
    ns.ladderKey = "empty";
    setMeta(`${stockProfile(next).label}  等待行情…`);
  }
  refresh(epoch).catch((err) => {
    if (epoch !== viewEpoch) return;
    if (!stockNs(next).data) setMeta(`拉取失败: ${err.message}`);
  });
}


window.addEventListener("pagehide", () => {
  for (const s of STOCKS) releaseCruiseLease(s.id);
});

restoreCruise();
refresh().catch((err) => {
  setMeta(`拉取失败: ${err.message}`);
});
setInterval(() => {
  refresh().catch(() => {});
}, 3000);

loadHangQty();
paintStockSwitch();
wireStockSwitch();
const cruiseBtn = document.getElementById("cruise-btn");
if (cruiseBtn) cruiseBtn.addEventListener("click", () => setCruise(!cruiseOn));
const cancelBuys = document.getElementById("cancel-buys");
const cancelSells = document.getElementById("cancel-sells");
if (cancelBuys) cancelBuys.addEventListener("click", () => cancelAll("buy"));
if (cancelSells) cancelSells.addEventListener("click", () => cancelAll("sell"));
applySimChrome();
const simToggle = document.getElementById("sim-toggle");
if (simToggle) {
  simToggle.addEventListener("click", () => setSimMode(!isSimMode()));
}
ensureHangBar();
wireHangBarButtons();
ensureCancelBar();
wireCancelBarButtons();

document.getElementById("ladder").addEventListener("click", (ev) => {
  if (cruiseOn && !isSimMode()) return;
  const hangTag = ev.target.closest(".tag.hang.live, .tag.hang.canceling, .tag.hang.request");
  if (hangTag) {
    ev.stopPropagation();
    onHangTagClick(hangTag, { x: ev.clientX, y: ev.clientY });
    return;
  }
  const priceEl = ev.target.closest(".price");
  if (!priceEl) return;
  const row = priceEl.closest(".ladder-row[data-idx]");
  if (!row) return;
  onPriceClick(row, { x: ev.clientX, y: ev.clientY });
});

(async function gateConsole() {
  try {
    const res = await fetch("/api/session", { cache: "no-store", credentials: "same-origin" });
    if (res.status === 401) {
      location.replace("/login.html");
      return;
    }
    const btn = document.getElementById("logout-btn");
    if (btn) {
      btn.hidden = false;
      btn.addEventListener("click", async () => {
        await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
        location.replace("/login.html");
      });
    }
  } catch (_err) {
    /* ignore */
  }
})();

(async function showAppVersion() {
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    const h = await res.json();
    const el = document.getElementById("app-version");
    if (el && h.appVersion) el.textContent = "v" + h.appVersion;
  } catch (_err) {
    /* ignore */
  }
})();
