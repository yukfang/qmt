// QMT deal-row helpers shared by the snapshot store and the cruise engine.

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function optSide(row) {
  const name = String((row && (row.m_strOptName || row.side)) || "");
  if (name.includes("卖")) return "sell";
  if (name.includes("买")) return "buy";
  return "";
}

const dealPrice = (row) => num(row && (row.m_dPrice || row.price));
const dealQty = (row) => Math.round(num(row && (row.m_nVolume || row.qty)));

function dealDateDigits(row) {
  const raw = String((row && (row.m_strTradeDate || row.date || row.m_strInsertDate)) || "").replace(/\D/g, "");
  return raw.length >= 8 ? raw.slice(0, 8) : "";
}

function dealTimeDigits(row) {
  const raw = String((row && (row.m_strTradeTime || row.time || row.m_strInsertTime || row.m_strTime)) || "").replace(/\D/g, "");
  return raw.length >= 5 ? raw.padStart(6, "0").slice(0, 6) : "";
}

function dealTimeRank(row, dateOverride) {
  const dateDigits = String(dateOverride || (row && (row.m_strTradeDate || row.date || row.m_strInsertDate)) || "").replace(/\D/g, "");
  const raw = String((row && (row.m_strTradeTime || row.time || row.m_strInsertTime || row.m_strTime)) || "").trim();
  // QMT sends times before 10:00 as 5 digits (92500 = 09:25:00). Leaving them unpadded
  // drops the date from the rank, so a morning fill loses to the previous day's afternoon fill.
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 5) digits = digits.padStart(6, "0");
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

// Latest deal in a QMT deal list, today or an earlier day. assumedDate fills in rows
// that QMT sent without a trade date (its deal list is the current session).
function pickLastDeal(deals, assumedDate) {
  const fallback = String(assumedDate || "").replace(/\D/g, "").slice(0, 8);
  let best = null;
  for (const row of deals || []) {
    const side = optSide(row);
    const price = Math.round(dealPrice(row) * 1000) / 1000;
    const qty = dealQty(row);
    const date = dealDateDigits(row) || (fallback.length === 8 ? fallback : "");
    if ((side !== "buy" && side !== "sell") || !(price > 0) || !(qty > 0) || !date) continue;
    const rank = dealTimeRank(row, date);
    if (!best || rank > best.rank) {
      best = {
        side,
        price,
        qty,
        date,
        time: dealTimeDigits(row),
        tradeId: String(row.m_strTradeID || row.trade_id || ""),
        orderId: String(row.m_strOrderSysID || row.order_id || ""),
        rank,
      };
    }
  }
  return best;
}

module.exports = { num, optSide, dealPrice, dealQty, dealDateDigits, dealTimeDigits, dealTimeRank, pickLastDeal };
