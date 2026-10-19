// API làm việc nhóm cho bản web trên Cloudflare Pages (Pages Functions + D1).
// Cùng giao kèo với server.cjs mà app.js đang dùng, khác ở đăng nhập: chỉ Google (Gmail).
//
// Biến môi trường / binding (wrangler.toml):
//   DB                 D1 database
//   GOOGLE_CLIENT_ID   OAuth Client ID (công khai) của Google Cloud
//   DEV_LOGIN=1        CHỈ dùng khi chạy cục bộ (wrangler pages dev): bật /api/auth/dev để thử nhiều tài khoản.
//                      Dù bật nhầm, route này vẫn từ chối mọi host không phải localhost/127.0.0.1.
import { verifyGoogleIdToken } from "../_lib/google.js";
import { HttpError, fail, isPlainObject, text, note, cleanProject } from "../_lib/validate.js";

const ROLE_RANK = { viewer: 1, commenter: 1.5, editor: 2, owner: 3 };
const ROLES = ["owner", "editor", "commenter", "viewer"];
const ROLE_NAME = { owner: "chủ dự án", editor: "chỉnh sửa", commenter: "bình luận", viewer: "chỉ xem" };
const BODY_LIMIT = 1_900_000; // một dòng D1 tối đa ~2 MB
const SESSION_DAYS = 30;
const MAX_PROJECTS = 100, MAX_MEMBERS = 60, MAX_EMAIL_INVITES = 60, MAX_LINK_INVITES = 50, MAX_AUDIT = 2000, MAX_COMMENTS = 5000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INTERNAL_ERROR = "Máy chủ gặp lỗi nội bộ. Vui lòng thử lại sau.";

/* ------------------------------------------------------------------ helpers */

const json = (status, data, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
async function sha256(value) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}
function randomHex(n = 32) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return hex(a);
}
function randomToken(n = 32) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function cookie(request, name) {
  const prefix = name + "=";
  return (request.headers.get("cookie") || "")
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(prefix))
    ?.slice(prefix.length);
}
function sessionCookie(request, value, maxAge) {
  const secure = new URL(request.url).protocol === "https:";
  return `nen_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}
async function readBody(request) {
  const type = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") fail(415, "Chỉ nhận JSON.");
  if (Number(request.headers.get("content-length") || 0) > BODY_LIMIT) fail(413, "Dữ liệu tối đa 1,9 MB.");
  const buf = await request.arrayBuffer();
  if (buf.byteLength > BODY_LIMIT) fail(413, "Dữ liệu tối đa 1,9 MB.");
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buf) || "{}");
  } catch {
    fail(400, "JSON không hợp lệ.");
  }
  if (!isPlainObject(value)) fail(400, "Dữ liệu gửi lên phải là đối tượng JSON.");
  return value;
}
const summary = (u) => ({ id: u.id, name: u.name, email: u.email, picture: u.picture || null });
const normalizeEmail = (v) => {
  const email = text(v, "Gmail", 3, 160).toLowerCase();
  if (!EMAIL_RE.test(email)) fail(400, "Địa chỉ Gmail không hợp lệ.");
  return email;
};
const isLocalHost = (request) => ["localhost", "127.0.0.1", "[::1]"].includes(new URL(request.url).hostname);

/* ---------------------------------------------------------- sessions & users */

async function currentUser(DB, request) {
  const raw = cookie(request, "nen_session");
  if (!raw || !/^[a-f0-9]{64}$/.test(raw)) return null;
  return DB.prepare("SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>?")
    .bind(await sha256(raw), Date.now())
    .first();
}
async function startSession(DB, request, user) {
  const raw = randomHex(32);
  await DB.batch([
    DB.prepare("DELETE FROM sessions WHERE expires<?").bind(Date.now()),
    DB.prepare("INSERT INTO sessions(token_hash,user_id,expires) VALUES(?,?,?)").bind(await sha256(raw), user.id, Date.now() + SESSION_DAYS * 86400000),
  ]);
  return sessionCookie(request, raw, SESSION_DAYS * 86400);
}
function auditStatements(DB, projectId, user, action, clientNote = null) {
  return [
    DB.prepare("INSERT INTO audit(project_id,actor_id,action,note,at) VALUES(?,?,?,?,?)").bind(projectId, user.id, action, clientNote, new Date().toISOString()),
    DB.prepare("DELETE FROM audit WHERE project_id=? AND id<=(SELECT id FROM audit WHERE project_id=? ORDER BY id DESC LIMIT 1 OFFSET ?)").bind(projectId, projectId, MAX_AUDIT),
  ];
}
/** Tạo/cập nhật tài khoản từ hồ sơ Google, rồi biến các lời mời theo Gmail thành quyền thành viên. */
async function signIn(DB, profile) {
  const now = new Date().toISOString();
  let user =
    (await DB.prepare("SELECT * FROM users WHERE google_sub=?").bind(profile.sub).first()) ||
    (await DB.prepare("SELECT * FROM users WHERE email=? AND google_sub IS NULL").bind(profile.email).first());
  if (user) {
    try {
      await DB.prepare("UPDATE users SET google_sub=?,email=?,name=?,picture=?,last_login=? WHERE id=?")
        .bind(profile.sub, profile.email, profile.name, profile.picture, now, user.id).run();
    } catch {
      // Email mới đã thuộc tài khoản khác: giữ email cũ, chỉ cập nhật tên/ảnh.
      await DB.prepare("UPDATE users SET google_sub=?,name=?,picture=?,last_login=? WHERE id=?").bind(profile.sub, profile.name, profile.picture, now, user.id).run();
    }
  } else {
    await DB.prepare("INSERT INTO users(google_sub,email,name,picture,created_at,last_login) VALUES(?,?,?,?,?,?)")
      .bind(profile.sub, profile.email, profile.name, profile.picture, now, now).run();
  }
  user = await DB.prepare("SELECT * FROM users WHERE google_sub=?").bind(profile.sub).first();
  const pending = (
    await DB.prepare("SELECT e.project_id,e.role FROM email_invites e JOIN projects p ON p.id=e.project_id AND p.deleted=0 WHERE e.email=?").bind(user.email).all()
  ).results;
  if (pending.length) {
    const statements = [];
    for (const invite of pending) {
      statements.push(DB.prepare("INSERT INTO members(project_id,user_id,role) VALUES(?,?,?) ON CONFLICT(project_id,user_id) DO NOTHING").bind(invite.project_id, user.id, invite.role));
      statements.push(...auditStatements(DB, invite.project_id, user, "Tham gia theo lời mời Gmail · " + ROLE_NAME[invite.role]));
    }
    statements.push(DB.prepare("DELETE FROM email_invites WHERE email=?").bind(user.email));
    await DB.batch(statements);
  }
  return user;
}

/* ------------------------------------------------------------- access */

async function access(DB, user, id, minimum = "viewer") {
  const p = await DB.prepare("SELECT p.*,m.role AS member_role FROM projects p LEFT JOIN members m ON m.project_id=p.id AND m.user_id=? WHERE p.id=?")
    .bind(user.id, id).first();
  if (!p || p.deleted) fail(404, "Dự án không tồn tại hoặc đã được xóa.");
  const role = p.owner_id === user.id ? "owner" : p.member_role;
  if (!role) fail(403, "Bạn chưa có quyền truy cập dự án.");
  if ((ROLE_RANK[role] || 0) < ROLE_RANK[minimum]) fail(403, "Quyền truy cập không đủ cho thao tác này.");
  return { ...p, role };
}
const payload = (row) => ({ ...JSON.parse(row.payload), _version: row.version, _role: row.role });
const memberRole = async (DB, projectId, userId) =>
  (await DB.prepare("SELECT role FROM members WHERE project_id=? AND user_id=?").bind(projectId, userId).first())?.role;

/* ------------------------------------------------------------------ routes */

async function route(request, env) {
  const DB = env.DB;
  if (!DB) fail(503, "Máy chủ chưa gắn cơ sở dữ liệu (binding DB).");
  const url = new URL(request.url), method = request.method, path = url.pathname.replace(/\/+$/, "");
  if (!["GET", "HEAD"].includes(method)) {
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== url.origin) fail(403, "Nguồn yêu cầu không hợp lệ.");
  }
  let user = await currentUser(DB, request);

  if (path === "/api/me" && method === "GET")
    return json(200, { user: user ? summary(user) : null, auth: "google", googleClientId: env.GOOGLE_CLIENT_ID || null, devLogin: env.DEV_LOGIN === "1" && isLocalHost(request) });

  if (path === "/api/auth/google" && method === "POST") {
    const body = await readBody(request);
    let profile;
    try {
      profile = await verifyGoogleIdToken(body.credential, { clientId: env.GOOGLE_CLIENT_ID });
    } catch (e) {
      fail(401, e.message || "Đăng nhập Google không thành công.");
    }
    user = await signIn(DB, profile);
    return json(200, { user: summary(user) }, { "Set-Cookie": await startSession(DB, request, user) });
  }

  if (path === "/api/auth/dev" && method === "POST") {
    if (env.DEV_LOGIN !== "1" || !isLocalHost(request)) fail(404, "Không tìm thấy API.");
    const body = await readBody(request), email = normalizeEmail(body.email);
    user = await signIn(DB, { sub: "dev:" + email, email, name: text(body.name || email.split("@")[0], "Tên", 1, 120), picture: null });
    return json(200, { user: summary(user) }, { "Set-Cookie": await startSession(DB, request, user) });
  }

  const invitation = path.match(/^\/api\/invites\/([A-Za-z0-9_-]{30,80})$/);
  if (invitation && method === "GET") {
    const invite = await DB.prepare(
      "SELECT i.role,i.expires,json_extract(p.payload,'$.name') AS name FROM invites i JOIN projects p ON p.id=i.project_id AND p.deleted=0 WHERE i.token_hash=? AND i.expires>?",
    ).bind(await sha256(invitation[1]), Date.now()).first();
    if (!invite) fail(404, "Lời mời đã hết hạn hoặc đã được sử dụng.");
    return json(200, invite);
  }

  if (!user) fail(401, "Vui lòng đăng nhập bằng Google.");

  if (invitation && method === "POST") {
    await readBody(request);
    const hash = await sha256(invitation[1]);
    const invite = await DB.prepare("SELECT i.* FROM invites i JOIN projects p ON p.id=i.project_id AND p.deleted=0 WHERE i.token_hash=? AND i.expires>?")
      .bind(hash, Date.now()).first();
    if (!invite) fail(404, "Lời mời đã hết hạn hoặc đã được sử dụng.");
    const project = await DB.prepare("SELECT owner_id FROM projects WHERE id=?").bind(invite.project_id).first();
    const inviterRole = project.owner_id === invite.creator ? "owner" : await memberRole(DB, invite.project_id, invite.creator);
    if (inviterRole !== "owner") {
      await DB.prepare("DELETE FROM invites WHERE token_hash=?").bind(hash).run();
      fail(410, "Người mời không còn quyền chủ dự án nên lời mời đã hết hiệu lực.");
    }
    const existing = await memberRole(DB, invite.project_id, user.id);
    const role = existing && ROLE_RANK[existing] > ROLE_RANK[invite.role] ? existing : invite.role;
    const results = await DB.batch([
      DB.prepare("DELETE FROM invites WHERE token_hash=?").bind(hash),
      DB.prepare("INSERT INTO members(project_id,user_id,role) VALUES(?,?,?) ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role").bind(invite.project_id, user.id, role),
      ...auditStatements(DB, invite.project_id, user, "Tham gia qua liên kết mời · " + ROLE_NAME[role]),
    ]);
    if (!results[0].meta.changes) fail(404, "Lời mời đã được sử dụng.");
    return json(200, { user: summary(user), projectId: invite.project_id });
  }

  if (path === "/api/logout" && method === "POST") {
    const raw = cookie(request, "nen_session");
    if (raw) await DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256(raw)).run();
    return json(200, { ok: true }, { "Set-Cookie": sessionCookie(request, "", 0) });
  }

  if (path === "/api/users" && method === "GET") {
    const users = (
      await DB.prepare(
        `SELECT DISTINCT u.id,u.name,u.email,u.picture FROM users u WHERE u.id=? OR u.id IN (
           SELECT other.user_id FROM members mine JOIN members other ON other.project_id=mine.project_id
           JOIN projects p ON p.id=mine.project_id AND p.deleted=0 WHERE mine.user_id=?) ORDER BY u.name`,
      ).bind(user.id, user.id).all()
    ).results;
    return json(200, { users });
  }

  if (path === "/api/projects" && method === "GET") {
    const rows = (
      await DB.prepare(
        `SELECT p.*,m.role,u.name AS owner_name,(SELECT count(*) FROM members x WHERE x.project_id=p.id) AS member_count,
                b.name AS updated_by_name
         FROM projects p JOIN members m ON m.project_id=p.id AND m.user_id=? JOIN users u ON u.id=p.owner_id
         LEFT JOIN users b ON b.id=p.updated_by WHERE p.deleted=0 ORDER BY p.updated DESC`,
      ).bind(user.id).all()
    ).results;
    return json(200, {
      projects: rows.map((r) => ({ ...payload(r), _owner: r.owner_name, _members: r.member_count, _updated: r.updated, _updatedBy: r.updated_by_name })),
    });
  }

  if (path === "/api/deleted-projects" && method === "GET") {
    const rows = (await DB.prepare("SELECT p.*,'owner' AS role FROM projects p WHERE p.owner_id=? AND p.deleted>0 ORDER BY p.deleted DESC LIMIT 100").bind(user.id).all()).results;
    return json(200, { projects: rows.map((r) => ({ ...payload(r), deletedAt: r.deleted })) });
  }

  if (path === "/api/projects" && method === "POST") {
    const body = await readBody(request), p = cleanProject(body.project), at = new Date().toISOString();
    const count = await DB.prepare("SELECT count(*) AS n FROM projects WHERE owner_id=?").bind(user.id).first();
    if (count.n >= MAX_PROJECTS) fail(400, "Tối đa 100 dự án cho mỗi tài khoản (tính cả dự án đã xóa).");
    if (await DB.prepare("SELECT id FROM projects WHERE id=?").bind(p.id).first()) fail(409, "Mã dự án đã tồn tại.");
    p.history = [{ at, actor: user.name, text: note(body.project.history?.[0]?.text) || "Tạo dự án" }];
    try {
      await DB.batch([
        DB.prepare("INSERT INTO projects(id,owner_id,payload,updated,updated_by) VALUES(?,?,?,?,?)").bind(p.id, user.id, JSON.stringify(p), at, user.id),
        DB.prepare("INSERT INTO members(project_id,user_id,role) VALUES(?,?,'owner')").bind(p.id, user.id),
        ...auditStatements(DB, p.id, user, "Tạo dự án"),
      ]);
    } catch (e) {
      if (/UNIQUE|constraint/i.test(String(e?.message))) fail(409, "Mã dự án đã tồn tại.");
      throw e;
    }
    return json(201, { id: p.id, version: 1 });
  }

  const match = path.match(/^\/api\/projects\/([A-Za-z0-9_-]{1,64})(?:\/(members|email-invites|audit|comments|invites|restore|version)(?:\/([A-Za-z0-9_-]{1,64}))?)?$/);
  if (!match) fail(404, "Không tìm thấy API.");
  const [, id, section, sub] = match;
  if (sub !== undefined && !["members", "invites"].includes(section)) fail(404, "Không tìm thấy API.");

  if (!section) {
    if (method === "GET") return json(200, { project: payload(await access(DB, user, id)) });
    if (method === "PUT") {
      const body = await readBody(request), row = await access(DB, user, id, "editor");
      if (!Number.isInteger(body.version) || body.version !== row.version)
        fail(409, "Dự án vừa được thành viên khác cập nhật. Bấm Tải lại dự án để lấy bản mới rồi sửa tiếp.");
      const p = cleanProject(body.project);
      if (p.id !== id) fail(400, "Không được đổi mã dự án.");
      const old = JSON.parse(row.payload), clientNote = note(body.project.history?.[0]?.text), at = new Date().toISOString();
      p.history = [{ at, actor: user.name, text: clientNote || "Cập nhật dự án" }, ...(old.history || [])].slice(0, 100);
      const results = await DB.batch([
        DB.prepare("UPDATE projects SET payload=?,version=version+1,updated=?,updated_by=? WHERE id=? AND version=?").bind(JSON.stringify(p), at, user.id, id, body.version),
        ...auditStatements(DB, id, user, `Cập nhật dự án (phiên bản ${body.version + 1})`, clientNote),
      ]);
      if (!results[0].meta.changes) fail(409, "Dữ liệu vừa thay đổi. Hãy tải lại dự án.");
      return json(200, { version: body.version + 1 });
    }
    if (method === "DELETE") {
      const body = await readBody(request), row = await access(DB, user, id, "owner");
      if (row.owner_id !== user.id) fail(403, "Chỉ chủ dự án gốc được xóa dự án.");
      if (body.version !== row.version) fail(409, "Dự án đã thay đổi. Tải lại trước khi xóa.");
      const results = await DB.batch([
        DB.prepare("UPDATE projects SET deleted=?,version=version+1 WHERE id=? AND version=?").bind(Date.now(), id, row.version),
        ...auditStatements(DB, id, user, "Xóa dự án"),
      ]);
      if (!results[0].meta.changes) fail(409, "Dự án đã thay đổi. Tải lại trước khi xóa.");
      return json(200, { ok: true });
    }
    fail(404, "Không tìm thấy API.");
  }

  // Nhẹ: các thành viên khác hỏi định kỳ để biết có bản mới không.
  if (section === "version" && method === "GET") {
    const row = await access(DB, user, id);
    const by = row.updated_by ? await DB.prepare("SELECT name FROM users WHERE id=?").bind(row.updated_by).first() : null;
    return json(200, { version: row.version, updated: row.updated, by: by?.name || null, byMe: row.updated_by === user.id });
  }

  if (section === "restore" && method === "POST") {
    const row = await DB.prepare("SELECT * FROM projects WHERE id=?").bind(id).first();
    if (!row || !row.deleted) fail(404, "Không tìm thấy dự án đã xóa.");
    if (row.owner_id !== user.id) fail(403, "Chỉ chủ dự án gốc được khôi phục.");
    await DB.batch([
      DB.prepare("UPDATE projects SET deleted=0,version=version+1,updated=?,updated_by=? WHERE id=?").bind(new Date().toISOString(), user.id, id),
      ...auditStatements(DB, id, user, "Khôi phục dự án"),
    ]);
    return json(200, { ok: true });
  }

  if (section === "members") {
    if (method === "GET" && sub === undefined) {
      const p = await access(DB, user, id);
      const members = (await DB.prepare("SELECT u.id,u.name,u.email,u.picture,m.role FROM members m JOIN users u ON u.id=m.user_id WHERE m.project_id=? ORDER BY m.role='owner' DESC,u.name").bind(id).all()).results;
      const pending = p.role === "owner"
        ? (await DB.prepare("SELECT e.email,e.role,u.name AS invited_by FROM email_invites e JOIN users u ON u.id=e.invited_by WHERE e.project_id=? ORDER BY e.created_at").bind(id).all()).results
        : [];
      return json(200, { members, pending, ownerId: p.owner_id });
    }
    if (method === "POST" && sub === undefined) {
      const body = await readBody(request), p = await access(DB, user, id, "owner");
      if (!ROLES.includes(body.role)) fail(400, "Vai trò không hợp lệ.");
      let target = null, email = null;
      if (body.email !== undefined) {
        email = normalizeEmail(body.email);
        target = await DB.prepare("SELECT * FROM users WHERE email=?").bind(email).first();
      } else if (Number.isInteger(body.userId)) {
        target = await DB.prepare("SELECT u.* FROM users u JOIN members m ON m.user_id=u.id AND m.project_id=? WHERE u.id=?").bind(id, body.userId).first();
        if (!target) fail(400, "Tài khoản không phải thành viên dự án.");
      } else fail(400, "Nhập Gmail của thành viên.");
      if (!target) {
        // Chưa từng đăng nhập: giữ lời mời theo Gmail, tự thành thành viên ở lần đăng nhập đầu.
        const n = await DB.prepare("SELECT count(*) AS n FROM email_invites WHERE project_id=?").bind(id).first();
        if (n.n >= MAX_EMAIL_INVITES) fail(400, "Tối đa 60 lời mời Gmail đang chờ.");
        await DB.batch([
          DB.prepare("INSERT INTO email_invites(project_id,email,role,invited_by,created_at) VALUES(?,?,?,?,?) ON CONFLICT(project_id,email) DO UPDATE SET role=excluded.role")
            .bind(id, email, body.role, user.id, new Date().toISOString()),
          ...auditStatements(DB, id, user, "Mời " + email + " · " + ROLE_NAME[body.role]),
        ]);
        return json(200, { ok: true, pending: true });
      }
      if (target.id === p.owner_id && body.role !== "owner") fail(400, "Chủ dự án gốc luôn giữ quyền chủ dự án.");
      const current = await memberRole(DB, id, target.id);
      if (current === "owner" && body.role !== "owner" && target.id !== user.id && user.id !== p.owner_id)
        fail(403, "Chỉ chủ dự án gốc được đổi quyền của chủ dự án khác.");
      if (!current) {
        const n = await DB.prepare("SELECT count(*) AS n FROM members WHERE project_id=?").bind(id).first();
        if (n.n >= MAX_MEMBERS) fail(400, "Tối đa 60 thành viên mỗi dự án.");
      }
      await DB.batch([
        DB.prepare("INSERT INTO members(project_id,user_id,role) VALUES(?,?,?) ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role").bind(id, target.id, body.role),
        DB.prepare("DELETE FROM email_invites WHERE project_id=? AND email=?").bind(id, target.email),
        ...auditStatements(DB, id, user, (current ? "Đổi quyền " : "Thêm ") + target.name + " · " + ROLE_NAME[body.role]),
      ]);
      return json(200, { ok: true, pending: false });
    }
    if (method === "DELETE" && sub !== undefined) {
      const targetId = Number(sub);
      if (!/^\d{1,15}$/.test(sub)) fail(400, "Mã tài khoản không hợp lệ.");
      const self = targetId === user.id, p = await access(DB, user, id, self ? "viewer" : "owner");
      if (targetId === p.owner_id) fail(400, "Không thể xóa chủ dự án gốc.");
      const current = await memberRole(DB, id, targetId);
      if (!current) fail(404, "Tài khoản không phải thành viên dự án.");
      if (!self && current === "owner" && user.id !== p.owner_id) fail(403, "Chỉ chủ dự án gốc được xóa chủ dự án khác.");
      await DB.batch([
        DB.prepare("DELETE FROM members WHERE project_id=? AND user_id=?").bind(id, targetId),
        DB.prepare("DELETE FROM invites WHERE project_id=? AND creator=?").bind(id, targetId),
        ...auditStatements(DB, id, user, self ? "Rời dự án" : "Gỡ thành viên #" + targetId),
      ]);
      return json(200, { ok: true });
    }
  }

  if (section === "email-invites" && method === "DELETE") {
    const body = await readBody(request);
    await access(DB, user, id, "owner");
    const email = normalizeEmail(body.email);
    const result = await DB.prepare("DELETE FROM email_invites WHERE project_id=? AND email=?").bind(id, email).run();
    if (!result.meta.changes) fail(404, "Không có lời mời cho Gmail này.");
    await DB.batch(auditStatements(DB, id, user, "Hủy lời mời " + email));
    return json(200, { ok: true });
  }

  if (section === "invites") {
    if (method === "POST" && sub === undefined) {
      const body = await readBody(request);
      await access(DB, user, id, "owner");
      if (!["editor", "viewer", "commenter"].includes(body.role)) fail(400, "Vai trò lời mời không hợp lệ.");
      await DB.prepare("DELETE FROM invites WHERE expires<?").bind(Date.now()).run();
      const n = await DB.prepare("SELECT count(*) AS n FROM invites WHERE project_id=?").bind(id).first();
      if (n.n >= MAX_LINK_INVITES) fail(400, "Tối đa 50 liên kết mời đang chờ. Thu hồi bớt liên kết cũ.");
      const raw = randomToken(), hash = await sha256(raw), expires = Date.now() + 7 * 86400000;
      await DB.batch([
        DB.prepare("INSERT INTO invites(token_hash,project_id,role,expires,creator) VALUES(?,?,?,?,?)").bind(hash, id, body.role, expires, user.id),
        ...auditStatements(DB, id, user, "Tạo liên kết mời · " + ROLE_NAME[body.role]),
      ]);
      return json(201, { token: raw, id: hash, expires });
    }
    if (method === "GET" && sub === undefined) {
      await access(DB, user, id, "owner");
      const invites = (await DB.prepare("SELECT i.token_hash AS id,i.role,i.expires,u.name AS creator FROM invites i JOIN users u ON u.id=i.creator WHERE i.project_id=? AND i.expires>? ORDER BY i.expires DESC").bind(id, Date.now()).all()).results;
      return json(200, { invites });
    }
    if (method === "DELETE" && sub !== undefined) {
      await access(DB, user, id, "owner");
      if (!/^[a-f0-9]{64}$/.test(sub)) fail(400, "Mã lời mời không hợp lệ.");
      const invite = await DB.prepare("SELECT role FROM invites WHERE token_hash=? AND project_id=?").bind(sub, id).first();
      if (!invite) fail(404, "Lời mời không tồn tại hoặc đã được sử dụng.");
      await DB.batch([DB.prepare("DELETE FROM invites WHERE token_hash=?").bind(sub), ...auditStatements(DB, id, user, "Thu hồi liên kết mời · " + ROLE_NAME[invite.role])]);
      return json(200, { ok: true });
    }
  }

  if (section === "comments" && method === "GET") {
    await access(DB, user, id);
    const comments = (await DB.prepare("SELECT c.id,c.body,c.at,c.user_id,u.name AS author,u.picture FROM comments c JOIN users u ON u.id=c.user_id WHERE c.project_id=? ORDER BY c.id DESC LIMIT 200").bind(id).all()).results;
    return json(200, { comments });
  }
  if (section === "comments" && method === "POST") {
    const body = await readBody(request);
    await access(DB, user, id, "commenter");
    const message = text(body.body, "Bình luận", 1, 5000);
    const n = await DB.prepare("SELECT count(*) AS n FROM comments WHERE project_id=?").bind(id).first();
    if (n.n >= MAX_COMMENTS) fail(400, "Dự án đã có 5.000 bình luận.");
    const created = await DB.prepare("INSERT INTO comments(project_id,user_id,body,at) VALUES(?,?,?,?)").bind(id, user.id, message, new Date().toISOString()).run();
    return json(201, { id: created.meta.last_row_id });
  }
  if (section === "audit" && method === "GET") {
    await access(DB, user, id);
    const events = (await DB.prepare("SELECT a.action,a.note,a.at,u.name AS actor FROM audit a LEFT JOIN users u ON u.id=a.actor_id WHERE a.project_id=? ORDER BY a.id DESC LIMIT 100").bind(id).all()).results;
    return json(200, { events });
  }
  fail(404, "Không tìm thấy API.");
}

export async function onRequest({ request, env }) {
  try {
    return await route(request, env);
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message });
    console.error("API error", e && e.stack ? e.stack : e);
    return json(500, { error: INTERNAL_ERROR });
  }
}
