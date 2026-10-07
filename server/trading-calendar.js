// Cruise only acts on A-share trading days between 07:00 and 17:00 Beijing time.
// Weekends are always closed; weekday exchange closures (SSE/SZSE holiday notices) are listed per
// year below. Weekend make-up workdays (调休上班) are still closed for trading, so they are not listed.
// A year missing from the table falls back to "every weekday trades" and says so in the reason.
const HOLIDAYS = {
  2026: [
    "20260101", "20260102", // 元旦
    "20260216", "20260217", "20260218", "20260219", "20260220", "20260223", // 春节
    "20260406", // 清明
    "20260501", "20260504", "20260505", // 劳动节
    "20260619", // 端午
    "20260925", // 中秋
    "20261001", "20261002", "20261005", "20261006", "20261007", // 国庆
  ],
};

const OPEN_MINUTE = 7 * 60;
const CLOSE_MINUTE = 17 * 60;

const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
  hourCycle: "h23",
});

function shanghaiParts(now) {
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}${parts.month}${parts.day}`,
    year: Number(parts.year),
    weekday: parts.weekday,
    minute: Number(parts.hour) * 60 + Number(parts.minute),
    hhmm: `${parts.hour}:${parts.minute}`,
  };
}

function isTradingDay(now = new Date()) {
  const p = shanghaiParts(now);
  if (p.weekday === "Sat" || p.weekday === "Sun") return { trading: false, reason: "周末休市" };
  const list = HOLIDAYS[p.year];
  if (!list) return { trading: true, reason: `未配置 ${p.year} 年休市日，按工作日计` };
  if (list.includes(p.date)) return { trading: false, reason: "节假日休市" };
  return { trading: true, reason: "" };
}

// { open, reason, date, time }: open means the cruise engine may place/cancel orders now.
function cruiseSession(now = new Date()) {
  const p = shanghaiParts(now);
  const day = isTradingDay(now);
  const base = { date: p.date, time: p.hhmm, window: "交易日 07:00–17:00" };
  if (!day.trading) return { ...base, open: false, reason: day.reason };
  if (p.minute < OPEN_MINUTE || p.minute >= CLOSE_MINUTE) {
    return { ...base, open: false, reason: "不在巡航时段" };
  }
  return { ...base, open: true, reason: day.reason };
}

module.exports = { cruiseSession, isTradingDay, HOLIDAYS };
