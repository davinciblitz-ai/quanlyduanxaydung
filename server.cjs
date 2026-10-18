/* Local and small-team preview server. Node 22.13+ provides the SQLite runtime. */
"use strict";
const http = require("node:http"),
  fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  zlib = require("node:zlib");
const { DatabaseSync } = require("node:sqlite");
const CT = require("./engine.js"), Planner = require("./planner.js"), Networks = require("./networks.js"), GraphBoard = require("./graph-board.js");
const ROOT = __dirname,
  DIR = process.env.NEN_DATA_DIR || path.join(ROOT, "data");
fs.mkdirSync(DIR, { recursive: true });
const db = new DatabaseSync(path.join(DIR, "nen.sqlite"));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,salt TEXT NOT NULL,hash TEXT NOT NULL,admin INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,owner_id INTEGER NOT NULL REFERENCES users(id),version INTEGER NOT NULL DEFAULT 1,payload TEXT NOT NULL,updated TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS members(project_id TEXT NOT NULL REFERENCES projects(id),user_id INTEGER NOT NULL REFERENCES users(id),role TEXT NOT NULL,PRIMARY KEY(project_id,user_id));
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,project_id TEXT NOT NULL,actor_id INTEGER NOT NULL,action TEXT NOT NULL,at TEXT NOT NULL);`);
if(!db.prepare("PRAGMA table_info(projects)").all().some(column=>column.name==='deleted'))db.exec("ALTER TABLE projects ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0");
db.exec(`CREATE TABLE IF NOT EXISTS comments(id INTEGER PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),user_id INTEGER NOT NULL REFERENCES users(id),body TEXT NOT NULL,at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS invites(token TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),role TEXT NOT NULL,expires INTEGER NOT NULL,creator INTEGER NOT NULL REFERENCES users(id));`);
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
const attempts = new Map();
function fail(status, message) {
  const e = new Error(message);
  e.status = status;
  throw e;
}
function text(v, name, min = 1, max = 200) {
  if (typeof v !== "string" || v.trim().length < min || v.length > max)
    fail(400, name + " không hợp lệ.");
  return v.trim();
}
function cleanProject(p) {
  if (!p || typeof p !== "object" || Array.isArray(p))
    fail(400, "Thiếu dữ liệu dự án.");
  text(p.id, "Mã dự án", 1, 64);
  if (!/^[A-Za-z0-9_-]+$/.test(p.id)) fail(400, "Mã dự án không hợp lệ.");
  text(p.name, "Tên dự án", 1, 160);
  if (!["VND", "USD"].includes(p.currency))
    fail(400, "Loại tiền không hợp lệ.");
  CT.dateAt(p.start, 0, p.workdays);
  if (new Set(p.workdays).size !== p.workdays.length)
    fail(400, "Ngày làm việc trùng lặp.");
  CT.number(p.statusDay, "Ngày báo cáo", 0, 100000, true);
  CT.number(p.capacity, "Năng lực", 0, 100000, true);
  CT.number(p.indirectBase, "Chi phí gián tiếp");
  CT.number(p.dailySaving, "Giảm gián tiếp");
  GraphBoard.validateLayouts(p.networkLayouts);
  Networks.validateTasks(p.tasks);
  Planner.validate(p);
  const r = Planner.active(p);
  if (r.duration > 100000) fail(400, "Tiến độ tối đa 100.000 ngày.");
  p.tasks.forEach((t) => {
    text(t.name, "Tên công việc", 1, 200);
    text(t.owner, "Phụ trách", 0, 160);
    if (t.stage !== undefined) CT.number(t.stage, "Giai đoạn", -1, 6, true);
  });
  CT.estimate(p.boq, p.estimate);
  const ids = new Set();
  p.boq.forEach((i) => {
    text(i.id, "Mã dự toán", 1, 64);
    if (ids.has(i.id)) fail(400, "Trùng mã dự toán.");
    ids.add(i.id);
    text(i.name, "Tên công tác", 1, 200);
    text(i.unit, "Đơn vị", 1, 20);
    text(i.task, "Mã công việc", 0, 24);
    if (i.task && !p.tasks.some((t) => t.id === i.task))
      fail(400, "Dự toán gắn mã công việc không tồn tại.");
  });
  CT.loan(
    p.finance.principal,
    p.finance.rate,
    p.finance.months,
    p.finance.method,
  );
  CT.appraisal(p.finance.flows, p.finance.discount);
  if (!Array.isArray(p.risks) || p.risks.length > 1000)
    fail(400, "Danh sách rủi ro không hợp lệ.");
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
  const next = {};
  for (const k of [
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
  ])
    next[k] = p[k];
  next.history = [];
  return next;
}
function summary(u) {
  return { id: u.id, name: u.name, email: u.email, admin: Boolean(u.admin) };
}
function passwordHash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}
function addUser(input, admin = false) {
  const name = text(input.name, "Họ tên", 1, 120),
    email = text(input.email, "Email", 3, 160).toLowerCase(),
    password = text(input.password, "Mật khẩu", 10, 128);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    fail(400, "Email không hợp lệ.");
  if (db.prepare("SELECT id FROM users WHERE email=?").get(email))
    fail(409, "Email đã tồn tại.");
  const salt = crypto.randomBytes(16).toString("hex"),
    hash = passwordHash(password, salt),
    r = db
      .prepare(
        "INSERT INTO users(name,email,salt,hash,admin) VALUES(?,?,?,?,?)",
      )
      .run(name, email, salt, hash, admin ? 1 : 0);
  return db.prepare("SELECT * FROM users WHERE id=?").get(r.lastInsertRowid);
}
function session(req) {
  const raw = req.headers.cookie
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith("nen_session="))
    ?.slice(12);
  if (!raw || !/^[a-f0-9]{64}$/.test(raw)) return null;
  const token = crypto.createHash("sha256").update(raw).digest("hex");
  return (
    db
      .prepare(
        "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?",
      )
      .get(token, Date.now()) || null
  );
}
function startSession(res, u) {
  const raw = crypto.randomBytes(32).toString("hex"),
    hash = crypto.createHash("sha256").update(raw).digest("hex");
  db.prepare("DELETE FROM sessions WHERE expires<?").run(Date.now());
  db.prepare("INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)").run(
    hash,
    u.id,
    Date.now() + 12 * 60 * 60 * 1000,
  );
  res.setHeader(
    "Set-Cookie",
    `nen_session=${raw}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${process.env.NEN_HTTPS === "1" ? "; Secure" : ""}`,
  );
}
function access(user, id, minimum = "viewer") {
  const p = db.prepare("SELECT * FROM projects WHERE id=?").get(id);
  if (!p || p.deleted) fail(404, "Dự án không tồn tại hoặc đã được xóa.");
  const member = db
      .prepare("SELECT role FROM members WHERE project_id=? AND user_id=?")
      .get(id, user.id),
    role = p.owner_id === user.id ? "owner" : member?.role;
  if (!role) fail(403, "Bạn chưa có quyền truy cập dự án.");
  if (
    ({ viewer: 1, commenter: 1.5, editor: 2, owner: 3 }[role] || 0) <
    { viewer: 1, commenter: 1.5, editor: 2, owner: 3 }[minimum]
  )
    fail(403, "Quyền truy cập không đủ cho thao tác này.");
  return { ...p, role };
}
function payload(row) {
  return { ...JSON.parse(row.payload), _version: row.version, _role: row.role };
}
function audit(id, user, action) {
  db.prepare(
    "INSERT INTO audit(project_id,actor_id,action,at) VALUES(?,?,?,?)",
  ).run(id, user.id, action, new Date().toISOString());
}
function respond(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}
async function readBody(req) {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    fail(415, "Chỉ nhận JSON.");
  let length = 0,
    data = "";
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 3 * 1024 * 1024) fail(413, "Dữ liệu tối đa 3 MB.");
    data += chunk;
  }
  try {
    return JSON.parse(data || "{}");
  } catch {
    fail(400, "JSON không hợp lệ.");
  }
}
async function api(req, res, url) {
  const method = req.method,
    pathname = url.pathname;
  if (!["GET", "HEAD"].includes(method)) {
    const expected =
      (process.env.NEN_HTTPS === "1" ? "https://" : "http://") +
      req.headers.host;
    if (req.headers.origin && req.headers.origin !== expected)
      fail(403, "Nguồn yêu cầu không hợp lệ.");
  }
  let user = session(req);
  if (pathname === "/api/me" && method === "GET")
    return respond(res, 200, {
      user: user ? summary(user) : null,
      setup: !db.prepare("SELECT id FROM users LIMIT 1").get(),
    });
  if (pathname === "/api/setup" && method === "POST") {
    if (db.prepare("SELECT id FROM users LIMIT 1").get())
      fail(403, "Không gian đã có quản trị.");
    const body = await readBody(req);
    if (db.prepare("SELECT id FROM users LIMIT 1").get())
      fail(403, "Không gian đã được thiết lập.");
    const u = addUser(body, true);
    startSession(res, u);
    return respond(res, 201, { user: summary(u) });
  }
  if (pathname === "/api/login" && method === "POST") {
    const b = await readBody(req),
      email = text(b.email, "Email", 3, 160).toLowerCase(),
      password = text(b.password, "Mật khẩu", 1, 128),
      key = req.socket.remoteAddress + "|" + email,
      now = Date.now();
    const a = attempts.get(key);
    if (a && a.until > now && a.count >= 10)
      fail(429, "Đăng nhập sai quá nhiều. Thử lại sau 10 phút.");
    const u = db.prepare("SELECT * FROM users WHERE email=?").get(email),
      salt = u?.salt || "dummy-salt-for-timing",
      candidate = passwordHash(password, salt);
    if (
      !u ||
      !crypto.timingSafeEqual(
        Buffer.from(candidate, "hex"),
        Buffer.from(u.hash, "hex"),
      )
    ) {
      const state = a && a.until > now ? a : { count: 0, until: now + 600000 };
      state.count++;
      attempts.set(key, state);
      if (attempts.size > 10000) {
        for (const [k, v] of attempts) if (v.until < now) attempts.delete(k);
      }
      fail(401, "Email hoặc mật khẩu không đúng.");
    }
    attempts.delete(key);
    startSession(res, u);
    return respond(res, 200, { user: summary(u) });
  }
  const invitation=pathname.match(/^\/api\/invites\/([A-Za-z0-9_-]{30,80})$/);
  if(invitation){
    const hash=crypto.createHash('sha256').update(invitation[1]).digest('hex');
    const get=()=>db.prepare("SELECT i.*,p.name FROM invites i JOIN (SELECT id,json_extract(payload,'$.name') AS name FROM projects WHERE deleted=0) p ON p.id=i.project_id WHERE token=? AND expires>?").get(hash,Date.now());
    if(method==='GET'){const invite=get();if(!invite)fail(404,'Lời mời đã hết hạn hoặc đã được sử dụng.');return respond(res,200,{name:invite.name,role:invite.role,expires:invite.expires});}
    if(method==='POST'){
      const body=await readBody(req);db.exec('BEGIN IMMEDIATE');let invite,created=false;
      try{
        invite=get();if(!invite)fail(404,'Lời mời đã hết hạn hoặc đã được sử dụng.');
        if(!user){user=addUser(body,false);created=true;}
        const current=db.prepare('SELECT role FROM members WHERE project_id=? AND user_id=?').get(invite.project_id,user.id);
        const rank={viewer:1,commenter:1.5,editor:2,owner:3},role=current&&rank[current.role]>rank[invite.role]?current.role:invite.role;
        db.prepare('INSERT INTO members VALUES(?,?,?) ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role').run(invite.project_id,user.id,role);
        db.prepare('DELETE FROM invites WHERE token=?').run(hash);audit(invite.project_id,user,'Tham gia qua lời mời · '+role);db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');throw error;}
      if(created)startSession(res,user);return respond(res,200,{user:summary(user),projectId:invite.project_id});
    }
  }
  if (!user) fail(401, "Vui lòng đăng nhập.");
  if (pathname === "/api/logout" && method === "POST") {
    await readBody(req);
    const raw = req.headers.cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("nen_session="))
      ?.slice(12);
    if (raw)
      db.prepare("DELETE FROM sessions WHERE token=?").run(
        crypto.createHash("sha256").update(raw).digest("hex"),
      );
    res.setHeader(
      "Set-Cookie",
      "nen_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
    );
    return respond(res, 200, { ok: true });
  }
  if (pathname === "/api/users" && method === "GET")
    return respond(res, 200, {
      users: db.prepare("SELECT id,name,email FROM users ORDER BY name").all(),
    });
  if (pathname === "/api/users" && method === "POST") {
    if (!user.admin) fail(403, "Chỉ quản trị tạo được tài khoản.");
    const u = addUser(await readBody(req));
    return respond(res, 201, { user: summary(u) });
  }
  if (pathname === "/api/projects" && method === "GET") {
    const rows = db
      .prepare(
        "SELECT p.*,m.role FROM projects p JOIN members m ON m.project_id=p.id WHERE m.user_id=? AND p.deleted=0 ORDER BY p.updated DESC",
      )
      .all(user.id);
    return respond(res, 200, { projects: rows.map(payload) });
  }
  if(pathname==='/api/deleted-projects'&&method==='GET'){const rows=db.prepare("SELECT p.*,m.role FROM projects p JOIN members m ON m.project_id=p.id WHERE m.user_id=? AND m.role='owner' AND p.deleted>0 ORDER BY p.deleted DESC LIMIT 100").all(user.id);return respond(res,200,{projects:rows.map(row=>({...payload(row),deletedAt:row.deleted}))});}
  if (pathname === "/api/projects" && method === "POST") {
    const b = await readBody(req),
      p = cleanProject(b.project);
    if (
      db
        .prepare("SELECT count(*) AS n FROM members m JOIN projects p ON p.id=m.project_id WHERE m.user_id=? AND p.deleted=0")
        .get(user.id).n >= 100
    )
      fail(400, "Tối đa 100 dự án cho mỗi tài khoản.");
    if (db.prepare("SELECT id FROM projects WHERE id=?").get(p.id))
      fail(409, "Mã dự án đã tồn tại.");
    p.history = [
      { at: new Date().toISOString(), actor: user.name, text: "Tạo dự án" },
    ];
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        "INSERT INTO projects(id,owner_id,payload,updated) VALUES(?,?,?,?)",
      ).run(p.id, user.id, JSON.stringify(p), new Date().toISOString());
      db.prepare("INSERT INTO members VALUES(?,?,?)").run(
        p.id,
        user.id,
        "owner",
      );
      audit(p.id, user, "Tạo dự án");
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    return respond(res, 201, { id: p.id, version: 1 });
  }
  const match = pathname.match(
    /^\/api\/projects\/([A-Za-z0-9_-]+)(?:\/(members|audit|comments|invites|restore))?$/,
  );
  if (match) {
    const id = match[1],
      section = match[2];
    if(section==='restore'&&method==='POST'){await readBody(req);const row=db.prepare('SELECT p.*,m.role FROM projects p LEFT JOIN members m ON m.project_id=p.id AND m.user_id=? WHERE p.id=?').get(user.id,id);if(!row||!row.deleted)fail(404,'Không tìm thấy dự án đã xóa.');if(row.owner_id!==user.id&&row.role!=='owner')fail(403,'Chỉ chủ dự án được khôi phục.');db.prepare('UPDATE projects SET deleted=0,version=version+1,updated=? WHERE id=?').run(new Date().toISOString(),id);audit(id,user,'Khôi phục dự án');return respond(res,200,{ok:true});}
    if(!section&&method==='DELETE'){const body=await readBody(req),row=access(user,id,'owner');if(body.version!==row.version)fail(409,'Dự án đã thay đổi. Tải lại trước khi xóa.');db.prepare('UPDATE projects SET deleted=?,version=version+1 WHERE id=? AND version=?').run(Date.now(),id,row.version);audit(id,user,'Xóa dự án');return respond(res,200,{ok:true});}
    if (!section && method === "GET")
      return respond(res, 200, { project: payload(access(user, id)) });
    if (!section && method === "PUT") {
      const b = await readBody(req),
        row = access(user, id, "editor");
      if (!Number.isInteger(b.version) || b.version !== row.version)
        fail(
          409,
          "Dự án đã được người khác cập nhật. Hãy xuất bản đang sửa nếu cần, rồi tải lại từ máy chủ.",
        );
      const p = cleanProject(b.project);
      if (p.id !== id) fail(400, "Không được đổi mã dự án.");
      const old = JSON.parse(row.payload),
        action =
          typeof b.project.history?.[0]?.text === "string"
            ? b.project.history[0].text.slice(0, 500)
            : "Cập nhật dự án";
      p.history = [
        { at: new Date().toISOString(), actor: user.name, text: action },
        ...(old.history || []),
      ].slice(0, 100);
      const result = db
        .prepare(
          "UPDATE projects SET payload=?,version=version+1,updated=? WHERE id=? AND version=?",
        )
        .run(JSON.stringify(p), new Date().toISOString(), id, b.version);
      if (!result.changes) fail(409, "Dữ liệu đã thay đổi. Hãy tải lại dự án.");
      audit(id, user, action);
      return respond(res, 200, { version: b.version + 1 });
    }
    if (section === "members" && method === "GET") {
      access(user, id);
      return respond(res, 200, {
        members: db
          .prepare(
            "SELECT u.id,u.name,u.email,m.role FROM members m JOIN users u ON u.id=m.user_id WHERE m.project_id=?",
          )
          .all(id),
      });
    }
    if (section === "members" && method === "POST") {
      const b = await readBody(req),
        p = access(user, id, "owner");
      if (
        !Number.isInteger(b.userId) ||
        !db.prepare("SELECT id FROM users WHERE id=?").get(b.userId)
      )
        fail(400, "Tài khoản không tồn tại.");
      if (!["owner", "editor", "viewer", "commenter"].includes(b.role))
        fail(400, "Vai trò không hợp lệ.");
      if (b.userId === p.owner_id && b.role !== "owner")
        fail(400, "Chủ dự án gốc luôn giữ quyền owner.");
      db.prepare(
        "INSERT INTO members VALUES(?,?,?) ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role",
      ).run(id, b.userId, b.role);
      audit(id, user, "Gán quyền " + b.role + " cho tài khoản #" + b.userId);
      return respond(res, 200, { ok: true });
    }
    if(section==='comments'&&method==='GET'){access(user,id);return respond(res,200,{comments:db.prepare('SELECT c.id,c.body,c.at,c.user_id,u.name AS author FROM comments c JOIN users u ON u.id=c.user_id WHERE c.project_id=? ORDER BY c.id DESC LIMIT 200').all(id)});}
    if(section==='comments'&&method==='POST'){access(user,id,'commenter');const body=await readBody(req),message=text(body.body,'Bình luận',1,5000);if(db.prepare('SELECT count(*) AS n FROM comments WHERE project_id=?').get(id).n>=5000)fail(400,'Dự án đã có 5.000 bình luận.');const created=db.prepare('INSERT INTO comments(project_id,user_id,body,at) VALUES(?,?,?,?)').run(id,user.id,message,new Date().toISOString());return respond(res,201,{id:Number(created.lastInsertRowid)});}
    if(section==='invites'&&method==='POST'){access(user,id,'owner');const body=await readBody(req);if(!['editor','viewer','commenter'].includes(body.role))fail(400,'Vai trò lời mời không hợp lệ.');db.prepare('DELETE FROM invites WHERE expires<?').run(Date.now());const raw=crypto.randomBytes(32).toString('base64url'),hash=crypto.createHash('sha256').update(raw).digest('hex'),expires=Date.now()+48*3600000;db.prepare('INSERT INTO invites VALUES(?,?,?,?,?)').run(hash,id,body.role,expires,user.id);audit(id,user,'Tạo lời mời · '+body.role);return respond(res,201,{token:raw,expires});}
    if (section === "audit" && method === "GET") {
      access(user, id);
      return respond(res, 200, {
        events: db
          .prepare(
            "SELECT a.action,a.at,u.name AS actor FROM audit a JOIN users u ON u.id=a.actor_id WHERE a.project_id=? ORDER BY a.id DESC LIMIT 100",
          )
          .all(id),
      });
    }
  }
  fail(404, "Không tìm thấy API.");
}
const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  );
  try {
    if (!req.headers.host) fail(400, "Thiếu Host.");
    const url = new URL(req.url, "http://" + req.headers.host);
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    if (!["GET", "HEAD"].includes(req.method))
      fail(405, "Phương thức không hỗ trợ.");
    const file =
      url.pathname === "/"
        ? "index.html"
        : decodeURIComponent(url.pathname.slice(1));
    if (!PUBLIC_FILES.has(file)) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(
        fs.existsSync(path.join(ROOT, "404.html"))
          ? fs.readFileSync(path.join(ROOT, "404.html"))
          : "404 · Không tìm thấy trang.",
      );
    }
    const target = path.join(ROOT, file);
    if (!fs.existsSync(target)) fail(404, "Tệp không tồn tại.");
    const gzip =
      /\bgzip\b/.test(req.headers["accept-encoding"] || "") &&
      fs.statSync(target).size > 1024;
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-cache",
      Vary: "Accept-Encoding",
      ...(gzip ? { "Content-Encoding": "gzip" } : {}),
    });
    if (req.method === "HEAD") res.end();
    else if (gzip)
      fs.createReadStream(target).pipe(zlib.createGzip()).pipe(res);
    else fs.createReadStream(target).pipe(res);
  } catch (e) {
    respond(res, e.status || 400, {
      error:
        e.status || e instanceof TypeError || e instanceof RangeError
          ? e.message
          : e.message || "Dữ liệu không hợp lệ.",
    });
  }
});
const port = Number(process.env.PORT) || 4173,
  host = process.env.HOST || "127.0.0.1";
server.listen(port, host, () => {
  console.log(
    `Quản lý dự án xây dựng đang chạy: http://${host === "0.0.0.0" ? "localhost" : host}:${port}\nDữ liệu SQLite: ${path.join(DIR, "nen.sqlite")}\nMở Cá nhân để dùng ngay; chọn Đội dự án → Kết nối để tạo tài khoản.`,
  );
});
server.on("error", (e) => {
  console.error(
    e.code === "EADDRINUSE"
      ? `Cổng ${port} đang dùng. Đặt PORT khác và chạy lại.`
      : e.message,
  );
  process.exitCode = 1;
});
process.on("SIGINT", () =>
  server.close(() => {
    db.close();
    process.exit(0);
  }),
);
