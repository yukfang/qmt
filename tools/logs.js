#!/usr/bin/env node
/**
 * 直接读 debug_log 表，看 QMT 策略日志。
 *
 *   node tools/logs.js                    最近 50 行
 *   node tools/logs.js -n 200 -s exec     执行器最近 200 行
 *   node tools/logs.js -l error --since 60
 *   node tools/logs.js -q "claim" -f      按关键字过滤并持续跟踪
 *
 * 参数：
 *   -n, --tail N        最近 N 行（默认 50）
 *   -s, --source NAME   status | exec | 其他 source
 *   -l, --level LEVEL   error（只看错误）| warn（警告和错误）
 *   -r, --run ID        只看某次策略启动（run_id）
 *   -q, --grep TEXT     message 包含 TEXT
 *       --since MIN     最近 MIN 分钟
 *   -f, --follow        持续输出新日志（每 2 秒）
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const db = require("../server/db");

function parseArgs(argv) {
  const out = { tail: 50, source: "", level: "", runId: "", q: "", sinceMinutes: 0, follow: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] || "";
    if (a === "-n" || a === "--tail") out.tail = Number(next()) || 50;
    else if (a === "-s" || a === "--source") out.source = next();
    else if (a === "-l" || a === "--level") out.level = next().toLowerCase();
    else if (a === "-r" || a === "--run") out.runId = next();
    else if (a === "-q" || a === "--grep") out.q = next();
    else if (a === "--since") out.sinceMinutes = Number(next()) || 0;
    else if (a === "-f" || a === "--follow") out.follow = true;
    else if (a === "-h" || a === "--help") {
      console.log(require("fs").readFileSync(__filename, "utf8").split("*/")[0]);
      process.exit(0);
    }
  }
  return out;
}

function line(item) {
  const ts = String(item.ts || item.createdAt || "");
  const auth = item.auth && item.auth !== "ok" ? ` auth=${item.auth}` : "";
  return `${item.id} ${ts} ${String(item.level || "info").toUpperCase().padEnd(5)} [${item.source || "-"} ${item.runId || "-"}${auth}] ${item.message}`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const filters = { source: opts.source, level: opts.level, runId: opts.runId, q: opts.q, sinceMinutes: opts.sinceMinutes };
  const first = await db.getDebug({ ...filters, tail: opts.tail });
  for (const item of first.items) console.log(line(item));
  if (!opts.follow) process.exit(0);
  let after = first.items.length ? first.nextAfter : first.lastId;
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const next = await db.getDebug({ ...filters, after, limit: 500 });
    for (const item of next.items) console.log(line(item));
    after = next.nextAfter;
  }
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
