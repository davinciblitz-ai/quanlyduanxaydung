/* Local and small-team preview server. Node 22.13+ provides the SQLite runtime.
 *
 * Environment:
 *   PORT, HOST               listen address (default 127.0.0.1:4173, loopback only)
 *   NEN_DATA_DIR             SQLite directory (default ./data)
 *   NEN_HTTPS=1              served over HTTPS (Secure cookie, HSTS, https origins)
 *   NEN_ORIGIN               comma list of public origins, e.g. https://qlda.example.com
 *   NEN_ALLOWED_HOSTS        comma list of extra Host values, e.g. qlda.local:4173,qlda.local
 *   NEN_TRUST_PROXY=1        take the client IP from X-Forwarded-For (only behind one trusted proxy)
 *   NEN_REQUIRE_SETUP_TOKEN=1  require the console setup token for the first admin even on loopback
 *                            (automatic when HOST is not loopback or any proxy/origin setting is set)
 *   NEN_PURGE_DELETED_DAYS   days before soft-deleted projects are purged (default 30, 0 = never)
 */
"use strict";
const http = require("node:http"),
  fs = require("node:fs"),
  fsp = require("node:fs/promises"),
  net = require("node:net"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  util = require("node:util"),
  zlib = require("node:zlib"),
  { pipeline } = require("node:stream");
const { DatabaseSync } = require("node:sqlite");
const CT = require("./engine.js"),
  Planner = require("./planner.js"),
  Networks = require("./networks.js"),
  GraphBoard = require("./graph-board.js");

const ROOT = __dirname,
  DIR = process.env.NEN_DATA_DIR || path.join(ROOT, "data"),
  PORT = Number(process.env.PORT) || 4173,
  HOST = process.env.HOST || "127.0.0.1",
  HTTPS = process.env.NEN_HTTPS === "1",
  TRUST_PROXY = process.env.NEN_TRUST_PROXY === "1",
  PURGE_DAYS = process.env.NEN_PURGE_DELETED_DAYS === undefined ? 30 : Number(process.env.NEN_PURGE_DELETED_DAYS) || 0;

const MAX_PROJECTS_PER_USER = 100,
  MAX_AUDIT_ROWS_PER_PROJECT = 2000,
  MAX_PENDING_INVITES = 50,
  BODY_LIMIT = 3 * 1024 * 1024,
  NOTE_LIMIT = 200,
  INTERNAL_ERROR = "Máy chủ gặp lỗi nội bộ. Vui lòng thử lại sau.";
const ROLE_RANK = { viewer: 1, commenter: 1.5, editor: 2, owner: 3 };

/* ---------------------------------------------------------------- database */

fs.mkdirSync(DIR, { recursive: true });
const db = new DatabaseSync(path.join(DIR, "nen.sqlite"));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,salt TEXT NOT NULL,hash TEXT NOT NULL,admin INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,owner_id INTEGER NOT NULL REFERENCES users(id),version INTEGER NOT NULL DEFAULT 1,payload TEXT NOT NULL,updated TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS members(project_id TEXT NOT NULL REFERENCES projects(id),user_id INTEGER NOT NULL REFERENCES users(id),role TEXT NOT NULL,PRIMARY KEY(project_id,user_id));
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,project_id TEXT NOT NULL,actor_id INTEGER NOT NULL,action TEXT NOT NULL,at TEXT NOT NULL);`);
const hasColumn = (table, column) =>
  db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
if (!hasColumn("projects", "deleted"))
  db.exec("ALTER TABLE projects ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0");
// Free text sent by the client (e.g. "Đã lưu bố trí sơ đồ") is kept apart from the server-written action.
if (!hasColumn("audit", "note")) db.exec("ALTER TABLE audit ADD COLUMN note TEXT");
db.exec(`CREATE TABLE IF NOT EXISTS comments(id INTEGER PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),user_id INTEGER NOT NULL REFERENCES users(id),body TEXT NOT NULL,at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS invites(token TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),role TEXT NOT NULL,expires INTEGER NOT NULL,creator INTEGER NOT NULL REFERENCES users(id));
CREATE INDEX IF NOT EXISTS audit_project ON audit(project_id,id);
CREATE INDEX IF NOT EXISTS members_user ON members(user_id);
CREATE INDEX IF NOT EXISTS invites_project ON invites(project_id);`);

/** Runs fn inside BEGIN IMMEDIATE…COMMIT. fn must be synchronous: the connection is shared by
 * all requests, so an await inside a transaction would let other requests write into it. */
function transaction(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw e;
  }
}
const isConstraintError = (e) => e?.code === "ERR_SQLITE_ERROR" && (e.errcode & 0xff) === 19;
const hasUsers = () => Boolean(db.prepare("SELECT id FROM users LIMIT 1").get());

/* ------------------------------------------------------------ static files */

const PUBLIC_FILES = new Set([
  "index.html",
  "styles.css",
  "polish.css",
  "engine.js",
  "networks.js",
  "graph-board.js",
  "planner.js",
  "planner-worker.js",
  "planning.css",
  "print-export.js",
  "vendor/html2canvas.min.js",
  "vendor/jspdf.umd.min.js",
  "vendor/jszip.min.js",
  "samples.js",
  "construction-sequence.js",
  "scene.js",
  "equipment.js",
  "fleet.js",
  "reinforcement.js",
  "theme-hcmut.css",
  "cinematic.css",
  "assets/scene-preview.webp",
  "assets/hcmut-logo.png",
  "assets/hcmut-favicon.png",
  "app.js",
  "boot.js",
  "webgl-scene.js",
  "vendor/three.module.js",
  "vendor/three.core.js",
  "vendor/OrbitControls.js",
  "vendor/RoomEnvironment.js",
  "vendor/RoundedBoxGeometry.js",
  "404.html",
  "vendor/motion.js",
  "vendor/phy-touch.js",
  "vendor/purify.min.js",
  "vendor/MOTION-LICENSE.md",
  "vendor/BeVietnamPro-Regular.ttf",
  "vendor/BeVietnamPro-SemiBold.ttf",
]);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".md": "text/plain; charset=utf-8",
};
// PNG/WebP/WOFF2 are already compressed; gzip would only cost CPU. (TTF is raw glyph data and shrinks well.)
const COMPRESSIBLE = new Set([".html", ".css", ".js", ".svg", ".md", ".ttf"]);
const CLIENT_GONE = new Set(["ERR_STREAM_PREMATURE_CLOSE", "ERR_STREAM_DESTROYED", "ECONNRESET", "EPIPE"]);

/* ----------------------------------------------------------------- helpers */

function fail(status, message, headers) {
  const e = new Error(message);
  e.status = status;
  if (headers) e.headers = headers;
  throw e;
}
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function text(v, name, min = 1, max = 200) {
  if (typeof v !== "string" || v.trim().length < min || v.length > max)
    fail(400, name + " không hợp lệ.");
  return v.trim();
}
/** Optional client note (history text) — never trusted as the audit action itself. */
function note(v) {
  if (typeof v !== "string") return null;
  // Array.from slices by code point so a Vietnamese/emoji character is never cut in half.
  const clean = Array.from(v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim()).slice(0, NOTE_LIMIT).join("");
  return clean.trim() || null;
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)),
    y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
function cookie(req, name) {
  const prefix = name + "=";
  return req.headers.cookie
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(prefix))
    ?.slice(prefix.length);
}
function addCookie(res, value) {
  const previous = res.getHeader("Set-Cookie");
  res.setHeader("Set-Cookie", previous ? [].concat(previous, value) : value);
}
function respond(res, status, data, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(data));
}

/* ------------------------------------------------------ project validation */

const PROJECT_FIELDS = [
  "id",
  "name",
  "currency",
  "start",
  "workdays",
  "statusDay",
  "capacity",
  "indirectBase",
  "dailySaving",
  "tasks",
  "boq",
  "estimate",
  "finance",
  "risks",
  "baseline",
  "planning",
  "networkLayouts",
];
function validateProject(p) {
  text(p.id, "Mã dự án", 1, 64);
  if (!/^[A-Za-z0-9_-]+$/.test(p.id)) fail(400, "Mã dự án không hợp lệ.");
  text(p.name, "Tên dự án", 1, 160);
  if (!["VND", "USD"].includes(p.currency)) fail(400, "Loại tiền không hợp lệ.");
  CT.dateAt(p.start, 0, p.workdays);
  if (new Set(p.workdays).size !== p.workdays.length) fail(400, "Ngày làm việc trùng lặp.");
  CT.number(p.statusDay, "Ngày báo cáo", 0, 100000, true);
  CT.number(p.capacity, "Năng lực", 0, 100000, true);
  CT.number(p.indirectBase, "Chi phí gián tiếp");
  CT.number(p.dailySaving, "Giảm gián tiếp");
  GraphBoard.validateLayouts(p.networkLayouts);
  Networks.validateTasks(p.tasks);
  Planner.validate(p);
  if (Planner.active(p).duration > 100000) fail(400, "Tiến độ tối đa 100.000 ngày.");
  p.tasks.forEach((t) => {
    text(t.name, "Tên công việc", 1, 200);
    text(t.owner, "Phụ trách", 0, 160);
    if (t.stage !== undefined) CT.number(t.stage, "Giai đoạn", -1, 6, true);
  });
  CT.estimate(p.boq, p.estimate);
  const boqIds = new Set();
  p.boq.forEach((i) => {
    text(i.id, "Mã dự toán", 1, 64);
    if (boqIds.has(i.id)) fail(400, "Trùng mã dự toán.");
    boqIds.add(i.id);
    text(i.name, "Tên công tác", 1, 200);
    text(i.unit, "Đơn vị", 1, 20);
    text(i.task, "Mã công việc", 0, 24);
    if (i.task && !p.tasks.some((t) => t.id === i.task))
      fail(400, "Dự toán gắn mã công việc không tồn tại.");
  });
  CT.loan(p.finance.principal, p.finance.rate, p.finance.months, p.finance.method);
  CT.appraisal(p.finance.flows, p.finance.discount);
  if (!Array.isArray(p.risks) || p.risks.length > 1000) fail(400, "Danh sách rủi ro không hợp lệ.");
  const riskIds = new Set();
  p.risks.forEach((r) => {
    text(r.id, "Mã rủi ro", 1, 64);
    if (riskIds.has(r.id)) fail(400, "Trùng mã rủi ro.");
    riskIds.add(r.id);
    text(r.name, "Tên rủi ro", 1, 300);
    text(r.owner, "Phụ trách", 0, 160);
    text(r.response, "Ứng phó", 0, 5000);
    CT.number(r.probability, "Xác suất", 1, 5, true);
    CT.number(r.impact, "Tác động", 1, 5, true);
    if (!["Đang theo dõi", "Đang xử lý", "Đã đóng"].includes(r.status))
      fail(400, "Trạng thái rủi ro không hợp lệ.");
  });
  if (p.baseline) {
    CT.number(p.baseline.duration, "Thời lượng gốc", 0, 100000, true);
    if (!Array.isArray(p.baseline.rows) || p.baseline.rows.length > 150)
      fail(400, "Kế hoạch gốc không hợp lệ.");
    p.baseline.rows.forEach((t) => {
      text(t.id, "Mã công việc gốc", 1, 24);
      CT.number(t.es, "ES gốc", 0, 100000, true);
      CT.number(t.ef, "EF gốc", t.es, 100000, true);
    });
  }
}
/** Validates a client project and keeps only the known top-level fields.
 * Nested objects (tasks, boq, planning…) are stored as sent; see report note. */
function cleanProject(p) {
  if (!isPlainObject(p)) fail(400, "Thiếu dữ liệu dự án.");
  try {
    validateProject(p);
  } catch (e) {
    if (e.status) throw e;
    // engine/planner/networks throw plain Error with a user-facing Vietnamese message.
    if (e.constructor === Error) fail(400, e.message);
    // TypeError/RangeError mean the shape is broken (e.g. finance missing); don't leak internals.
    fail(400, "Dữ liệu dự án không hợp lệ.");
  }
  const next = {};
  for (const k of PROJECT_FIELDS) next[k] = p[k];
  next.history = [];
  return next;
}

/* ------------------------------------------------------- passwords & users */

const scrypt = util.promisify(crypto.scrypt);
const DUMMY_SALT = crypto.randomBytes(16).toString("hex");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// scrypt runs on the libuv pool; cap concurrent hashes and the queue so a login flood
// cannot starve file I/O or grow memory without bound.
const HASH_CONCURRENCY = 4,
  HASH_QUEUE_LIMIT = 64;
let hashActive = 0;
const hashQueue = [];
async function withHashSlot(fn) {
  if (hashActive < HASH_CONCURRENCY) hashActive++;
  else {
    if (hashQueue.length >= HASH_QUEUE_LIMIT)
      fail(503, "Máy chủ đang bận. Thử lại sau ít giây.", { "Retry-After": "5" });
    await new Promise((resolve) => hashQueue.push(resolve)); // slot is handed over on release
  }
  try {
    return await fn();
  } finally {
    const next = hashQueue.shift();
    if (next) next();
    else hashActive--;
  }
}
/** Same parameters/format as the former scryptSync(password, salt, 64) → hex. */
async function passwordHash(password, salt) {
  const key = await withHashSlot(() => scrypt(password, salt, 64));
  return key.toString("hex");
}
async function verifyPassword(user, password) {
  // Older builds trimmed passwords before hashing: if the untrimmed form fails, try the trimmed one.
  const candidates = [password];
  if (password.trim() && password.trim() !== password) candidates.push(password.trim());
  for (const candidate of candidates) {
    // Unknown emails are hashed too so response time does not reveal which accounts exist.
    const hash = await passwordHash(candidate, user?.salt || DUMMY_SALT);
    if (user && safeEqual(hash, user.hash)) return true;
  }
  return false;
}
function summary(u) {
  return { id: u.id, name: u.name, email: u.email, admin: Boolean(u.admin) };
}
const emailTaken = (email) => Boolean(db.prepare("SELECT id FROM users WHERE email=?").get(email));
/** Validates the new-account form and hashes the password (async, outside any transaction). */
async function prepareUser(input) {
  if (!isPlainObject(input)) fail(400, "Thiếu thông tin tài khoản.");
  const name = text(input.name, "Họ tên", 1, 120),
    email = text(input.email, "Email", 3, 160).toLowerCase(),
    password = input.password;
  // Passwords are stored exactly as typed; the 10-character rule ignores outer spaces as before.
  if (typeof password !== "string" || password.length > 128 || password.trim().length < 10)
    fail(400, "Mật khẩu không hợp lệ.");
  if (!EMAIL_RE.test(email)) fail(400, "Email không hợp lệ.");
  if (emailTaken(email)) fail(409, "Email đã tồn tại.");
  const salt = crypto.randomBytes(16).toString("hex");
  return { name, email, salt, hash: await passwordHash(password, salt) };
}
/** Synchronous insert of a prepared user; safe inside transaction(). */
function insertUser(prepared, admin = false) {
  if (emailTaken(prepared.email)) fail(409, "Email đã tồn tại.");
  let r;
  try {
    r = db
      .prepare("INSERT INTO users(name,email,salt,hash,admin) VALUES(?,?,?,?,?)")
      .run(prepared.name, prepared.email, prepared.salt, prepared.hash, admin ? 1 : 0);
  } catch (e) {
    if (isConstraintError(e)) fail(409, "Email đã tồn tại.");
    throw e;
  }
  return db.prepare("SELECT * FROM users WHERE id=?").get(r.lastInsertRowid);
}

/* ---------------------------------------------------------- login limiting */

const LOGIN_WINDOW = 15 * 60 * 1000,
  LIMITER_MAX_ENTRIES = 10000,
  IP_MAX_FAILURES = 50;
const loginFailures = new Map(); // key -> { count, last }; Map order = least recently failed first
function failureEntry(key, now) {
  const entry = loginFailures.get(key);
  if (entry && now - entry.last > LOGIN_WINDOW) {
    loginFailures.delete(key);
    return null;
  }
  return entry || null;
}
function recordFailure(key, now) {
  const entry = failureEntry(key, now) || { count: 0, last: now };
  entry.count++;
  entry.last = now;
  loginFailures.delete(key); // re-insert so the Map stays ordered by recency
  loginFailures.set(key, entry);
  if (loginFailures.size > LIMITER_MAX_ENTRIES) {
    for (const [k, v] of loginFailures) if (now - v.last > LOGIN_WINDOW) loginFailures.delete(k);
    for (const k of loginFailures.keys()) {
      if (loginFailures.size <= LIMITER_MAX_ENTRIES) break;
      loginFailures.delete(k); // still full: drop the oldest entries
    }
  }
}
/** Milliseconds the caller must still wait, or 0. */
function loginDelay(ip, email, now) {
  const byIp = failureEntry("ip|" + ip, now),
    byPair = failureEntry("pair|" + ip + "|" + email, now),
    byEmail = failureEntry("email|" + email, now);
  let wait = 0;
  // One address: hard cap on failures per window (protects CPU and slows password spraying).
  if (byIp && byIp.count >= IP_MAX_FAILURES) wait = Math.max(wait, byIp.last + LOGIN_WINDOW - now);
  // Same address + account: exponential backoff after 5 failures, at most 15 minutes.
  if (byPair && byPair.count >= 5)
    wait = Math.max(wait, byPair.last + Math.min(2 ** (byPair.count - 5) * 1000, LOGIN_WINDOW) - now);
  // Account from anywhere: short backoff (≤ 30 s) so other addresses cannot lock the owner out.
  if (byEmail && byEmail.count >= 10)
    wait = Math.max(wait, byEmail.last + Math.min(2 ** (byEmail.count - 10) * 1000, 30000) - now);
  return Math.max(0, wait);
}
function clientIp(req) {
  if (TRUST_PROXY) {
    // Use the right-most entry: it is the address our (single) trusted proxy saw; entries to its
    // left come from the client and can be forged.
    const hops = String(req.headers["x-forwarded-for"] || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return req.socket.remoteAddress || "unknown";
}

/* ------------------------------------------------- Host / Origin allowlist */

const DEFAULT_PORT = HTTPS ? 443 : 80;
const SCHEME = HTTPS ? "https:" : "http:";
/** "name[:port]" → { name, port|null } or null when malformed. */
function parseHost(value) {
  if (typeof value !== "string" || !value || value.length > 300) return null;
  let u;
  try {
    u = new URL("http://" + value);
  } catch {
    return null;
  }
  if (u.username || u.password || u.pathname !== "/" || u.search || u.hash) return null;
  return { name: u.hostname.toLowerCase(), port: u.port ? Number(u.port) : null };
}
const EXTRA_ORIGINS = [],
  EXTRA_HOSTS = [];
for (const raw of (process.env.NEN_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean)) {
  try {
    const u = new URL(raw);
    EXTRA_ORIGINS.push(u.origin);
    EXTRA_HOSTS.push({ name: u.hostname.toLowerCase(), port: null });
  } catch {
    console.warn("Bỏ qua NEN_ORIGIN không hợp lệ: " + raw);
  }
}
for (const raw of (process.env.NEN_ALLOWED_HOSTS || "").split(",").map((s) => s.trim()).filter(Boolean)) {
  const h = parseHost(raw);
  if (h) EXTRA_HOSTS.push(h); // an entry without a port accepts any port
  else console.warn("Bỏ qua NEN_ALLOWED_HOSTS không hợp lệ: " + raw);
}
const isLoopbackName = (name) =>
  name === "localhost" || name === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(name);
const isIpLiteral = (name) => net.isIP(name.replace(/^\[(.*)\]$/, "$1")) !== 0;
const matchesExtra = (h, port) =>
  EXTRA_HOSTS.some((e) => e.name === h.name && (e.port === null || e.port === port));
/**
 * Host header check against DNS rebinding. Rebinding needs an attacker-controlled *name*, so
 * localhost and IP literals on our port are safe (LAN use with HOST=0.0.0.0 keeps working);
 * any other name must be listed in NEN_ALLOWED_HOSTS / NEN_ORIGIN.
 */
function hostAllowed(h) {
  if (!h) return false;
  const port = h.port ?? DEFAULT_PORT;
  if (matchesExtra(h, port)) return true;
  return (isLoopbackName(h.name) || isIpLiteral(h.name)) && port === PORT;
}
/** Origin of a state-changing request: our own (validated) Host, loopback on our port, or configured origins. */
function originAllowed(origin, requestHost) {
  if (EXTRA_ORIGINS.includes(origin)) return true;
  let u;
  try {
    u = new URL(origin);
  } catch {
    return false; // includes the opaque "null" origin
  }
  if (u.protocol !== SCHEME || u.origin !== origin) return false;
  const h = { name: u.hostname.toLowerCase(), port: u.port ? Number(u.port) : DEFAULT_PORT },
    port = h.port;
  if (h.name === requestHost.name && port === (requestHost.port ?? DEFAULT_PORT)) return true;
  if (matchesExtra(h, port)) return true;
  return isLoopbackName(h.name) && port === PORT;
}

/* --------------------------------------------- first-admin setup token */

const LOOPBACK_BIND = HOST === "localhost" || HOST === "::1" || /^127\./.test(HOST);
// When the server is reachable from other machines (non-loopback bind, or a loopback bind behind a
// reverse proxy — signalled by the proxy/origin settings), the first visitor must not be able to
// claim the admin account: require a one-time token printed on the server console.
const SETUP_NEEDS_TOKEN =
  !LOOPBACK_BIND ||
  process.env.NEN_REQUIRE_SETUP_TOKEN === "1" ||
  TRUST_PROXY ||
  EXTRA_HOSTS.length > 0;
let setupToken = SETUP_NEEDS_TOKEN && !hasUsers() ? crypto.randomBytes(24).toString("base64url") : null;
const SETUP_TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

/* --------------------------------------------------------------- sessions */

function session(req) {
  const raw = cookie(req, "nen_session");
  if (!raw || !/^[a-f0-9]{64}$/.test(raw)) return null;
  return (
    db
      .prepare("SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?")
      .get(sha256(raw), Date.now()) || null
  );
}
function startSession(res, u) {
  const raw = crypto.randomBytes(32).toString("hex");
  db.prepare("DELETE FROM sessions WHERE expires<?").run(Date.now());
  db.prepare("INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)").run(
    sha256(raw),
    u.id,
    Date.now() + 12 * 60 * 60 * 1000,
  );
  addCookie(res, `nen_session=${raw}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${HTTPS ? "; Secure" : ""}`);
}

/* ------------------------------------------------------- access & records */

function access(user, id, minimum = "viewer") {
  const p = db.prepare("SELECT * FROM projects WHERE id=?").get(id);
  if (!p || p.deleted) fail(404, "Dự án không tồn tại hoặc đã được xóa.");
  const member = db.prepare("SELECT role FROM members WHERE project_id=? AND user_id=?").get(id, user.id),
    role = p.owner_id === user.id ? "owner" : member?.role;
  if (!role) fail(403, "Bạn chưa có quyền truy cập dự án.");
  if ((ROLE_RANK[role] || 0) < ROLE_RANK[minimum]) fail(403, "Quyền truy cập không đủ cho thao tác này.");
  return { ...p, role };
}
const memberRole = (projectId, userId) =>
  db.prepare("SELECT role FROM members WHERE project_id=? AND user_id=?").get(projectId, userId)?.role;
function payload(row) {
  return { ...JSON.parse(row.payload), _version: row.version, _role: row.role };
}
function audit(projectId, user, action, clientNote = null) {
  db.prepare("INSERT INTO audit(project_id,actor_id,action,at,note) VALUES(?,?,?,?,?)").run(
    projectId,
    user.id,
    action,
    new Date().toISOString(),
    clientNote,
  );
  // Keep only the newest rows per project.
  db.prepare(
    "DELETE FROM audit WHERE project_id=? AND id<=(SELECT id FROM audit WHERE project_id=? ORDER BY id DESC LIMIT 1 OFFSET ?)",
  ).run(projectId, projectId, MAX_AUDIT_ROWS_PER_PROJECT);
}
/** Admins see every account; others only accounts sharing a live project with them (and themselves). */
function visibleUsers(user) {
  if (user.admin) return db.prepare("SELECT id,name,email FROM users ORDER BY name").all();
  return db
    .prepare(
      `SELECT id,name,email FROM users WHERE id=? OR id IN (
         SELECT other.user_id FROM members mine
         JOIN members other ON other.project_id=mine.project_id
         JOIN projects p ON p.id=mine.project_id AND p.deleted=0
         WHERE mine.user_id=?)
       ORDER BY name`,
    )
    .all(user.id, user.id);
}
function canSeeUser(user, targetId) {
  if (user.admin || targetId === user.id)
    return Boolean(db.prepare("SELECT id FROM users WHERE id=?").get(targetId));
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM members mine
         JOIN members other ON other.project_id=mine.project_id
         JOIN projects p ON p.id=mine.project_id AND p.deleted=0
         WHERE mine.user_id=? AND other.user_id=? LIMIT 1`,
      )
      .get(user.id, targetId),
  );
}
/** Live memberships plus deleted projects the user still owns (they occupy storage until purged). */
function projectCount(user) {
  return db
    .prepare(
      `SELECT (SELECT count(*) FROM members m JOIN projects p ON p.id=m.project_id WHERE m.user_id=? AND p.deleted=0)
            + (SELECT count(*) FROM projects WHERE owner_id=? AND deleted>0) AS n`,
    )
    .get(user.id, user.id).n;
}
function purgeDeletedProjects() {
  if (!(PURGE_DAYS > 0)) return;
  const cutoff = Date.now() - PURGE_DAYS * 86400000;
  for (const { id } of db.prepare("SELECT id FROM projects WHERE deleted>0 AND deleted<?").all(cutoff)) {
    transaction(() => {
      for (const table of ["comments", "invites", "members", "audit"])
        db.prepare(`DELETE FROM ${table} WHERE project_id=?`).run(id);
      db.prepare("DELETE FROM projects WHERE id=?").run(id);
    });
  }
}
function inviterIsOwner(invite) {
  const project = db.prepare("SELECT owner_id FROM projects WHERE id=?").get(invite.project_id);
  return Boolean(project) && (project.owner_id === invite.creator || memberRole(invite.project_id, invite.creator) === "owner");
}

/* ------------------------------------------------------------ request body */

function parseContentType(value) {
  const [essence, ...params] = String(value || "").split(";");
  let charset = null;
  for (const param of params) {
    const eq = param.indexOf("=");
    if (eq > 0 && param.slice(0, eq).trim().toLowerCase() === "charset")
      charset = param.slice(eq + 1).trim().replace(/^"|"$/g, "").toLowerCase();
  }
  return { essence: essence.trim().toLowerCase(), charset };
}
/** Reads a JSON object body. Chunks are kept as Buffers and decoded once so multi-byte
 * UTF-8 characters split across chunks are not corrupted. */
async function readBody(req) {
  const type = parseContentType(req.headers["content-type"]);
  if (type.essence !== "application/json" || (type.charset && !["utf-8", "utf8"].includes(type.charset)))
    fail(415, "Chỉ nhận JSON.");
  const tooLarge = () => fail(413, "Dữ liệu tối đa 3 MB.", { Connection: "close" });
  if (Number(req.headers["content-length"]) > BODY_LIMIT) tooLarge();
  const raw = await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0,
      settled = false;
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      error ? reject(error) : resolve(value);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > BODY_LIMIT) {
        try {
          tooLarge();
        } catch (e) {
          settle(e);
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => settle(null, Buffer.concat(chunks)));
    req.on("error", () => settle(Object.assign(new Error("Không đọc được dữ liệu gửi lên."), { status: 400 })));
    req.on("close", () => settle(Object.assign(new Error("Kết nối bị ngắt."), { status: 400 })));
  });
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw) || "{}");
  } catch {
    fail(400, "JSON không hợp lệ.");
  }
  if (!isPlainObject(value)) fail(400, "Dữ liệu gửi lên phải là đối tượng JSON.");
  return value;
}

/* ---------------------------------------------------------------- API */

async function api(req, res, url, requestHost) {
  const method = req.method,
    pathname = url.pathname;
  if (!["GET", "HEAD"].includes(method) && req.headers.origin !== undefined) {
    if (!originAllowed(req.headers.origin, requestHost)) fail(403, "Nguồn yêu cầu không hợp lệ.");
  }
  let user = session(req);

  if (pathname === "/api/me" && method === "GET") {
    const setup = !hasUsers();
    return respond(res, 200, {
      user: user ? summary(user) : null,
      setup,
      setupTokenRequired: setup && Boolean(setupToken),
    });
  }

  if (pathname === "/api/setup" && method === "POST") {
    if (hasUsers()) fail(403, "Không gian đã có quản trị.");
    const body = await readBody(req);
    if (setupToken) {
      const provided = body.setupToken || req.headers["x-setup-token"] || cookie(req, "nen_setup") || "";
      if (!safeEqual(provided, setupToken))
        fail(403, "Cần mã thiết lập. Mở liên kết thiết lập được in trong cửa sổ chạy máy chủ.");
    }
    const prepared = await prepareUser(body);
    const admin = transaction(() => {
      if (hasUsers()) fail(403, "Không gian đã được thiết lập.");
      return insertUser(prepared, true);
    });
    setupToken = null;
    startSession(res, admin);
    if (cookie(req, "nen_setup")) addCookie(res, "nen_setup=; HttpOnly; SameSite=Strict; Path=/api/setup; Max-Age=0");
    return respond(res, 201, { user: summary(admin) });
  }

  if (pathname === "/api/login" && method === "POST") {
    const body = await readBody(req),
      email = text(body.email, "Email", 3, 160).toLowerCase(),
      password = body.password;
    if (typeof password !== "string" || !password.length || password.length > 128)
      fail(400, "Mật khẩu không hợp lệ.");
    const ip = clientIp(req),
      wait = loginDelay(ip, email, Date.now());
    if (wait > 0) {
      const seconds = Math.ceil(wait / 1000);
      fail(429, `Đăng nhập sai quá nhiều. Thử lại sau ${seconds} giây.`, { "Retry-After": String(seconds) });
    }
    const u = db.prepare("SELECT * FROM users WHERE email=?").get(email);
    if (!(await verifyPassword(u, password))) {
      const now = Date.now();
      recordFailure("ip|" + ip, now);
      recordFailure("pair|" + ip + "|" + email, now);
      recordFailure("email|" + email, now);
      fail(401, "Email hoặc mật khẩu không đúng.");
    }
    loginFailures.delete("pair|" + ip + "|" + email);
    loginFailures.delete("email|" + email);
    startSession(res, u);
    return respond(res, 200, { user: summary(u) });
  }

  const invitation = pathname.match(/^\/api\/invites\/([A-Za-z0-9_-]{30,80})$/);
  if (invitation) {
    const hash = sha256(invitation[1]);
    const find = () =>
      db
        .prepare(
          "SELECT i.*,p.name FROM invites i JOIN (SELECT id,json_extract(payload,'$.name') AS name FROM projects WHERE deleted=0) p ON p.id=i.project_id WHERE token=? AND expires>?",
        )
        .get(hash, Date.now());
    const gone = () => fail(404, "Lời mời đã hết hạn hoặc đã được sử dụng.");
    const revokeIfInviterLostOwner = (invite) => {
      if (inviterIsOwner(invite)) return;
      db.prepare("DELETE FROM invites WHERE token=?").run(hash);
      fail(410, "Người mời không còn quyền owner nên lời mời đã hết hiệu lực.");
    };
    if (method === "GET") {
      const invite = find() || gone();
      revokeIfInviterLostOwner(invite);
      return respond(res, 200, { name: invite.name, role: invite.role, expires: invite.expires });
    }
    if (method === "POST") {
      const body = await readBody(req);
      // Validate the invite before spending a password hash on it.
      revokeIfInviterLostOwner(find() || gone());
      const prepared = user ? null : await prepareUser(body);
      let created = false;
      const invite = transaction(() => {
        const current = find() || gone();
        if (!inviterIsOwner(current)) gone();
        if (!user) {
          user = insertUser(prepared, false);
          created = true;
        }
        const existing = memberRole(current.project_id, user.id),
          role = existing && ROLE_RANK[existing] > ROLE_RANK[current.role] ? existing : current.role;
        db.prepare(
          "INSERT INTO members VALUES(?,?,?) ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role",
        ).run(current.project_id, user.id, role);
        db.prepare("DELETE FROM invites WHERE token=?").run(hash);
        audit(current.project_id, user, "Tham gia qua lời mời · " + role);
        return current;
      });
      if (created) startSession(res, user);
      return respond(res, 200, { user: summary(user), projectId: invite.project_id });
    }
  }

  if (!user) fail(401, "Vui lòng đăng nhập.");

  if (pathname === "/api/logout" && method === "POST") {
    await readBody(req);
    const raw = cookie(req, "nen_session");
    if (raw) db.prepare("DELETE FROM sessions WHERE token=?").run(sha256(raw));
    res.setHeader("Set-Cookie", "nen_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
    return respond(res, 200, { ok: true });
  }
  if (pathname === "/api/users" && method === "GET") return respond(res, 200, { users: visibleUsers(user) });
  if (pathname === "/api/users" && method === "POST") {
    if (!user.admin) fail(403, "Chỉ quản trị tạo được tài khoản.");
    const prepared = await prepareUser(await readBody(req));
    return respond(res, 201, { user: summary(insertUser(prepared, false)) });
  }
  if (pathname === "/api/projects" && method === "GET") {
    const rows = db
      .prepare(
        "SELECT p.*,m.role FROM projects p JOIN members m ON m.project_id=p.id WHERE m.user_id=? AND p.deleted=0 ORDER BY p.updated DESC",
      )
      .all(user.id);
    return respond(res, 200, { projects: rows.map(payload) });
  }
  if (pathname === "/api/deleted-projects" && method === "GET") {
    // Only the original owner can restore, so only their deleted projects are listed.
    const rows = db
      .prepare("SELECT p.*,'owner' AS role FROM projects p WHERE p.owner_id=? AND p.deleted>0 ORDER BY p.deleted DESC LIMIT 100")
      .all(user.id);
    return respond(res, 200, {
      projects: rows.map((row) => ({ ...payload(row), deletedAt: row.deleted })),
      purgeAfterDays: PURGE_DAYS > 0 ? PURGE_DAYS : null,
    });
  }
  if (pathname === "/api/projects" && method === "POST") {
    const body = await readBody(req),
      p = cleanProject(body.project),
      at = new Date().toISOString();
    p.history = [{ at, actor: user.name, text: "Tạo dự án" }];
    transaction(() => {
      if (projectCount(user) >= MAX_PROJECTS_PER_USER)
        fail(400, "Tối đa 100 dự án cho mỗi tài khoản (tính cả dự án đã xóa chưa dọn).");
      if (db.prepare("SELECT id FROM projects WHERE id=?").get(p.id)) fail(409, "Mã dự án đã tồn tại.");
      try {
        db.prepare("INSERT INTO projects(id,owner_id,payload,updated) VALUES(?,?,?,?)").run(
          p.id,
          user.id,
          JSON.stringify(p),
          at,
        );
      } catch (e) {
        if (isConstraintError(e)) fail(409, "Mã dự án đã tồn tại.");
        throw e;
      }
      db.prepare("INSERT INTO members VALUES(?,?,?)").run(p.id, user.id, "owner");
      audit(p.id, user, "Tạo dự án");
    });
    return respond(res, 201, { id: p.id, version: 1 });
  }

  const match = pathname.match(
    /^\/api\/projects\/([A-Za-z0-9_-]+)(?:\/(members|audit|comments|invites|restore)(?:\/([A-Za-z0-9_-]{1,64}))?)?$/,
  );
  if (match) {
    const [, id, section, sub] = match;
    if (sub !== undefined && !["members", "invites"].includes(section)) fail(404, "Không tìm thấy API.");
    if (!section) return projectRoute(req, res, method, user, id);
    if (section === "restore" && method === "POST") {
      await readBody(req);
      const row = db.prepare("SELECT * FROM projects WHERE id=?").get(id);
      if (!row || !row.deleted) fail(404, "Không tìm thấy dự án đã xóa.");
      if (row.owner_id !== user.id) fail(403, "Chỉ chủ dự án gốc được khôi phục.");
      transaction(() => {
        db.prepare("UPDATE projects SET deleted=0,version=version+1,updated=? WHERE id=?").run(new Date().toISOString(), id);
        audit(id, user, "Khôi phục dự án");
      });
      return respond(res, 200, { ok: true });
    }
    if (section === "members") return membersRoute(req, res, method, user, id, sub);
    if (section === "invites") return invitesRoute(req, res, method, user, id, sub);
    if (section === "comments" && method === "GET") {
      access(user, id);
      return respond(res, 200, {
        comments: db
          .prepare(
            "SELECT c.id,c.body,c.at,c.user_id,u.name AS author FROM comments c JOIN users u ON u.id=c.user_id WHERE c.project_id=? ORDER BY c.id DESC LIMIT 200",
          )
          .all(id),
      });
    }
    if (section === "comments" && method === "POST") {
      access(user, id, "commenter");
      const body = await readBody(req),
        message = text(body.body, "Bình luận", 1, 5000);
      access(user, id, "commenter"); // re-check after the await
      if (db.prepare("SELECT count(*) AS n FROM comments WHERE project_id=?").get(id).n >= 5000)
        fail(400, "Dự án đã có 5.000 bình luận.");
      const created = db
        .prepare("INSERT INTO comments(project_id,user_id,body,at) VALUES(?,?,?,?)")
        .run(id, user.id, message, new Date().toISOString());
      return respond(res, 201, { id: Number(created.lastInsertRowid) });
    }
    if (section === "audit" && method === "GET") {
      access(user, id);
      return respond(res, 200, {
        events: db
          .prepare(
            "SELECT a.action,a.note,a.at,u.name AS actor FROM audit a JOIN users u ON u.id=a.actor_id WHERE a.project_id=? ORDER BY a.id DESC LIMIT 100",
          )
          .all(id),
      });
    }
  }
  fail(404, "Không tìm thấy API.");
}

/** GET / PUT / DELETE /api/projects/:id */
async function projectRoute(req, res, method, user, id) {
  if (method === "GET") return respond(res, 200, { project: payload(access(user, id)) });
  if (method === "PUT") {
    const body = await readBody(req),
      row = access(user, id, "editor");
    if (!Number.isInteger(body.version) || body.version !== row.version)
      fail(409, "Dự án đã được người khác cập nhật. Hãy xuất bản đang sửa nếu cần, rồi tải lại từ máy chủ.");
    const p = cleanProject(body.project);
    if (p.id !== id) fail(400, "Không được đổi mã dự án.");
    const old = JSON.parse(row.payload),
      nextVersion = body.version + 1,
      clientNote = note(body.project.history?.[0]?.text),
      at = new Date().toISOString();
    // Project history shows the editor's own description (attributed to them by the server);
    // the audit action is always written by the server.
    p.history = [{ at, actor: user.name, text: clientNote || "Cập nhật dự án" }, ...(old.history || [])].slice(0, 100);
    transaction(() => {
      const result = db
        .prepare("UPDATE projects SET payload=?,version=version+1,updated=? WHERE id=? AND version=?")
        .run(JSON.stringify(p), at, id, body.version);
      if (!result.changes) fail(409, "Dữ liệu đã thay đổi. Hãy tải lại dự án.");
      audit(id, user, `Cập nhật dự án (phiên bản ${nextVersion})`, clientNote);
    });
    return respond(res, 200, { version: nextVersion });
  }
  if (method === "DELETE") {
    const body = await readBody(req),
      row = access(user, id, "owner");
    if (row.owner_id !== user.id) fail(403, "Chỉ chủ dự án gốc được xóa dự án.");
    if (body.version !== row.version) fail(409, "Dự án đã thay đổi. Tải lại trước khi xóa.");
    transaction(() => {
      const result = db
        .prepare("UPDATE projects SET deleted=?,version=version+1 WHERE id=? AND version=?")
        .run(Date.now(), id, row.version);
      if (!result.changes) fail(409, "Dự án đã thay đổi. Tải lại trước khi xóa.");
      audit(id, user, "Xóa dự án");
    });
    return respond(res, 200, { ok: true });
  }
  fail(404, "Không tìm thấy API.");
}

/** /api/projects/:id/members[/:userId] */
async function membersRoute(req, res, method, user, id, sub) {
  if (method === "GET" && sub === undefined) {
    access(user, id);
    return respond(res, 200, {
      members: db
        .prepare("SELECT u.id,u.name,u.email,m.role FROM members m JOIN users u ON u.id=m.user_id WHERE m.project_id=?")
        .all(id),
    });
  }
  if (method === "POST" && sub === undefined) {
    const body = await readBody(req),
      p = access(user, id, "owner");
    // Same message for "no such account" and "not visible to you": no account enumeration.
    if (!Number.isInteger(body.userId) || !canSeeUser(user, body.userId)) fail(400, "Tài khoản không tồn tại.");
    if (!["owner", "editor", "viewer", "commenter"].includes(body.role)) fail(400, "Vai trò không hợp lệ.");
    if (body.userId === p.owner_id && body.role !== "owner") fail(400, "Chủ dự án gốc luôn giữ quyền owner.");
    const current = memberRole(id, body.userId);
    // Co-owners cannot demote each other; only the original owner manages other owners.
    if (current === "owner" && body.role !== "owner" && body.userId !== user.id && user.id !== p.owner_id)
      fail(403, "Chỉ chủ dự án gốc được đổi quyền của owner khác.");
    transaction(() => {
      db.prepare(
        "INSERT INTO members VALUES(?,?,?) ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role",
      ).run(id, body.userId, body.role);
      audit(id, user, "Gán quyền " + body.role + " cho tài khoản #" + body.userId);
    });
    return respond(res, 200, { ok: true });
  }
  if (method === "DELETE" && sub !== undefined) {
    const targetId = Number(sub);
    if (!/^\d{1,15}$/.test(sub) || !Number.isSafeInteger(targetId)) fail(400, "Mã tài khoản không hợp lệ.");
    const self = targetId === user.id,
      p = access(user, id, self ? "viewer" : "owner"); // anyone may leave; only owners remove others
    if (targetId === p.owner_id) fail(400, "Không thể xóa chủ dự án gốc.");
    const current = memberRole(id, targetId);
    if (!current) fail(404, "Tài khoản không phải thành viên dự án.");
    if (!self && current === "owner" && user.id !== p.owner_id)
      fail(403, "Chỉ chủ dự án gốc được xóa owner khác.");
    transaction(() => {
      db.prepare("DELETE FROM members WHERE project_id=? AND user_id=?").run(id, targetId);
      // Pending invites created by the removed member would be rejected at acceptance anyway.
      db.prepare("DELETE FROM invites WHERE project_id=? AND creator=?").run(id, targetId);
      audit(id, user, self ? "Rời dự án" : "Xóa thành viên tài khoản #" + targetId);
    });
    return respond(res, 200, { ok: true });
  }
  fail(404, "Không tìm thấy API.");
}

/** /api/projects/:id/invites[/:inviteId] — owners create, list and revoke invite links. */
async function invitesRoute(req, res, method, user, id, sub) {
  if (method === "POST" && sub === undefined) {
    access(user, id, "owner");
    const body = await readBody(req);
    if (!["editor", "viewer", "commenter"].includes(body.role)) fail(400, "Vai trò lời mời không hợp lệ.");
    access(user, id, "owner"); // re-check after the await
    db.prepare("DELETE FROM invites WHERE expires<?").run(Date.now());
    if (db.prepare("SELECT count(*) AS n FROM invites WHERE project_id=?").get(id).n >= MAX_PENDING_INVITES)
      fail(400, "Tối đa 50 lời mời đang chờ. Thu hồi bớt lời mời cũ.");
    const raw = crypto.randomBytes(32).toString("base64url"),
      hash = sha256(raw),
      expires = Date.now() + 48 * 3600000;
    transaction(() => {
      db.prepare("INSERT INTO invites VALUES(?,?,?,?,?)").run(hash, id, body.role, expires, user.id);
      audit(id, user, "Tạo lời mời · " + body.role);
    });
    return respond(res, 201, { token: raw, id: hash, expires });
  }
  if (method === "GET" && sub === undefined) {
    access(user, id, "owner");
    // Only the SHA-256 of each token is stored, so the link itself cannot be shown again.
    return respond(res, 200, {
      invites: db
        .prepare(
          "SELECT i.token AS id,i.role,i.expires,u.name AS creator FROM invites i JOIN users u ON u.id=i.creator WHERE i.project_id=? AND i.expires>? ORDER BY i.expires DESC",
        )
        .all(id, Date.now()),
    });
  }
  if (method === "DELETE" && sub !== undefined) {
    access(user, id, "owner");
    if (!/^[a-f0-9]{64}$/.test(sub)) fail(400, "Mã lời mời không hợp lệ.");
    const invite = db.prepare("SELECT role FROM invites WHERE token=? AND project_id=?").get(sub, id);
    if (!invite) fail(404, "Lời mời không tồn tại hoặc đã được sử dụng.");
    transaction(() => {
      db.prepare("DELETE FROM invites WHERE token=?").run(sub);
      audit(id, user, "Thu hồi lời mời · " + invite.role);
    });
    return respond(res, 200, { ok: true });
  }
  fail(404, "Không tìm thấy API.");
}

/* ---------------------------------------------------------- static serving */

function acceptsGzip(header) {
  let gzip = null,
    any = null;
  for (const part of String(header || "").split(",")) {
    const [token, ...params] = part.split(";"),
      name = token.trim().toLowerCase();
    if (!name) continue;
    let q = 1;
    for (const param of params) {
      const [key, value] = param.split("=");
      if (key.trim().toLowerCase() === "q") q = Number(value) || 0; // "q=0" or junk → not acceptable
    }
    if (name === "gzip" || name === "x-gzip") gzip = Math.max(gzip ?? 0, q);
    else if (name === "*") any = q;
  }
  return gzip !== null ? gzip > 0 : any !== null && any > 0;
}
function cacheControl(file) {
  // URLs carry no version hash, so code and HTML always revalidate (cheap 304 via ETag).
  if ([".html", ".js", ".css", ".md"].includes(path.extname(file))) return "no-cache";
  return "public, max-age=86400";
}
function notModified(req, etag, mtimeMs) {
  const ifNoneMatch = req.headers["if-none-match"];
  if (ifNoneMatch) {
    const bare = (tag) => tag.trim().replace(/^W\//, "");
    return ifNoneMatch.split(",").some((tag) => tag.trim() === "*" || bare(tag) === bare(etag));
  }
  const since = Date.parse(req.headers["if-modified-since"] || "");
  return Number.isFinite(since) && Math.floor(mtimeMs / 1000) * 1000 <= since;
}
async function sendNotFoundPage(req, res) {
  let body;
  try {
    body = await fsp.readFile(path.join(ROOT, "404.html"));
  } catch {
    body = "404 · Không tìm thấy trang.";
  }
  res.writeHead(404, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
  res.end(req.method === "HEAD" ? undefined : body);
}
async function serveStatic(req, res, url) {
  if (!["GET", "HEAD"].includes(req.method)) fail(405, "Phương thức không hỗ trợ.", { Allow: "GET, HEAD" });
  // One-time setup link printed on the console: keep the token in a cookie scoped to /api/setup
  // and redirect so it does not stay in the address bar.
  if (url.pathname === "/" && url.searchParams.has("setup")) {
    const token = url.searchParams.get("setup");
    if (setupToken && SETUP_TOKEN_RE.test(token))
      addCookie(res, `nen_setup=${token}; HttpOnly; SameSite=Strict; Path=/api/setup; Max-Age=3600${HTTPS ? "; Secure" : ""}`);
    res.writeHead(303, { Location: "/", "Cache-Control": "no-store" });
    return res.end();
  }
  let file = null;
  try {
    file = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  } catch {
    // malformed %-escape → treated as not found
  }
  if (!file || !PUBLIC_FILES.has(file)) return sendNotFoundPage(req, res);

  let handle;
  try {
    handle = await fsp.open(path.join(ROOT, file), "r");
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "EISDIR") fail(404, "Tệp không tồn tại.");
    throw e; // EBUSY/EACCES… → logged, generic 500
  }
  let stream = null,
    headers,
    gzip = false;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) fail(404, "Tệp không tồn tại.");
    const ext = path.extname(file),
      etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    headers = {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": cacheControl(file),
      ETag: etag,
      "Last-Modified": stat.mtime.toUTCString(),
      Vary: "Accept-Encoding",
    };
    if (notModified(req, etag, stat.mtimeMs)) {
      res.writeHead(304, headers);
      return res.end();
    }
    gzip = COMPRESSIBLE.has(ext) && stat.size > 1024 && acceptsGzip(req.headers["accept-encoding"]);
    if (gzip) headers["Content-Encoding"] = "gzip";
    else headers["Content-Length"] = stat.size;
    if (req.method === "HEAD") {
      res.writeHead(200, headers);
      return res.end();
    }
    stream = handle.createReadStream(); // the stream now owns the handle (autoClose)
  } finally {
    if (!stream) await handle.close().catch(() => {});
  }
  res.writeHead(200, headers);
  // pipeline destroys every stream (and closes the file) on error or client abort.
  const steps = gzip ? [stream, zlib.createGzip(), res] : [stream, res];
  pipeline(...steps, (error) => {
    if (!error) return;
    // A client closing the tab mid-download is normal; anything else (EBUSY, EACCES…) is logged.
    if (!CLIENT_GONE.has(error.code)) console.error(`Lỗi gửi tệp ${file}:`, error);
    res.destroy();
  });
}

/* ------------------------------------------------------------------ server */

function handleError(req, res, e) {
  if (res.headersSent) {
    if (!e?.status) console.error(`[${new Date().toISOString()}] ${req.method} ${req.url}`, e);
    return res.destroy();
  }
  if (e?.status) return respond(res, e.status, { error: e.message }, e.headers);
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.url}`, e);
  respond(res, 500, { error: INTERNAL_ERROR });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  );
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  if (HTTPS) res.setHeader("Strict-Transport-Security", "max-age=15552000");
  try {
    if (!req.headers.host) fail(400, "Thiếu Host.");
    const requestHost = parseHost(req.headers.host);
    if (!hostAllowed(requestHost))
      fail(421, "Tên miền truy cập không được phép. Thêm vào NEN_ALLOWED_HOSTS nếu triển khai sau tên miền riêng.");
    // Base URL is fixed: the Host header is only used after it passed the allowlist.
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) return await api(req, res, url, requestHost);
    return await serveStatic(req, res, url);
  } catch (e) {
    handleError(req, res, e);
  }
});

process.on("uncaughtException", (error) => {
  console.error(`[${new Date().toISOString()}] uncaughtException:`, error);
  if (db.isOpen && db.isTransaction) {
    try {
      db.exec("ROLLBACK");
    } catch {}
  }
});
process.on("unhandledRejection", (reason) => {
  console.error(`[${new Date().toISOString()}] unhandledRejection:`, reason);
});

try {
  purgeDeletedProjects();
} catch (e) {
  console.error("Không dọn được dự án đã xóa:", e);
}
setInterval(() => {
  try {
    purgeDeletedProjects();
  } catch (e) {
    console.error("Không dọn được dự án đã xóa:", e);
  }
}, 6 * 3600000).unref();

server.listen(PORT, HOST, () => {
  const shown = HOST === "0.0.0.0" || HOST === "::" ? "localhost" : HOST.includes(":") ? `[${HOST}]` : HOST,
    base = `http://${shown}:${PORT}`;
  console.log(
    `Quản lý dự án xây dựng đang chạy: ${base}\nDữ liệu SQLite: ${path.join(DIR, "nen.sqlite")}\nMở Cá nhân để dùng ngay; chọn Đội dự án → Kết nối để tạo tài khoản.`,
  );
  if (setupToken)
    console.log(
      `Máy chủ mở cho mạng ngoài và chưa có quản trị. Mở liên kết dùng một lần sau để tạo tài khoản quản trị đầu tiên:\n${base}/?setup=${setupToken}\n(hoặc gửi "setupToken" trong POST /api/setup)`,
    );
});
server.on("error", (e) => {
  console.error(e.code === "EADDRINUSE" ? `Cổng ${PORT} đang dùng. Đặt PORT khác và chạy lại.` : e.message);
  process.exitCode = 1;
});
process.on("SIGINT", () =>
  server.close(() => {
    db.close();
    process.exit(0);
  }),
);
