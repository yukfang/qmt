const crypto = require("crypto");

const COOKIE = "console_session";
const MAX_AGE_SEC = 7 * 24 * 3600;

const USER = String(process.env.CONSOLE_USER || "admin").trim();
const PASSWORD = String(process.env.CONSOLE_PASSWORD || "");
const SECRET = String(process.env.SESSION_SECRET || "").trim();

function websiteAuthEnabled() {
  return Boolean(PASSWORD);
}

function sessionSecret() {
  if (SECRET) return SECRET;
  if (!websiteAuthEnabled()) return "dev-open";
  // 未配 SESSION_SECRET 时用密码派生，重启后 cookie 仍可用
  return crypto.createHash("sha256").update(`ptrade:${PASSWORD}`).digest("hex");
}

function timingEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) {
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function sign(payloadB64) {
  return crypto.createHmac("sha256", sessionSecret()).update(payloadB64).digest("base64url");
}

function encodeSession(user) {
  const payload = Buffer.from(
    JSON.stringify({ u: user, exp: Date.now() + MAX_AGE_SEC * 1000 }),
    "utf8"
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function decodeSession(token) {
  if (!token || typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!timingEqual(sign(payload), mac)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data || !data.u || !data.exp || Date.now() > Number(data.exp)) return null;
    return data;
  } catch (_err) {
    return null;
  }
}

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  const out = {};
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch (_err) {
      out[k] = v;
    }
  }
  return out;
}

function readSession(req) {
  if (!websiteAuthEnabled()) {
    return { user: USER, open: true };
  }
  const data = decodeSession(parseCookies(req)[COOKIE]);
  if (!data) return null;
  return { user: data.u };
}

function cookieFlags(req) {
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "");
  const secure = proto.includes("https");
  const parts = [`Path=/`, `HttpOnly`, `SameSite=Lax`, `Max-Age=${MAX_AGE_SEC}`];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function setSessionCookie(req, res, user) {
  res.setHeader("Set-Cookie", `${COOKIE}=${encodeURIComponent(encodeSession(user))}; ${cookieFlags(req)}`);
}

function clearSessionCookie(req, res) {
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "");
  const secure = proto.includes("https") ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

function tryLogin(username, password) {
  if (!websiteAuthEnabled()) {
    return { ok: true, user: USER, open: true };
  }
  const u = String(username || "");
  const p = String(password || "");
  if (timingEqual(u, USER) && timingEqual(p, PASSWORD)) {
    return { ok: true, user: USER };
  }
  return { ok: false };
}

function requirePageLogin(req, res, next) {
  if (!websiteAuthEnabled()) return next();
  if (readSession(req)) return next();
  if (req.path === "/" || req.path === "/index.html") {
    res.redirect("/login.html");
    return;
  }
  return next();
}

function currentUser(req) {
  const sess = readSession(req);
  if (sess && sess.user) return sess.user;
  if (!websiteAuthEnabled()) return USER;
  return null;
}

function requireUser(req, res, next) {
  const user = currentUser(req);
  if (!user) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }
  req.username = user;
  return next();
}

module.exports = {
  websiteAuthEnabled,
  readSession,
  currentUser,
  requireUser,
  setSessionCookie,
  clearSessionCookie,
  tryLogin,
  requirePageLogin,
  USER,
};
