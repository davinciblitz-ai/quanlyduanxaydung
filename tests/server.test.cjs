"use strict";
const assert = require("node:assert/strict"),
  { spawn } = require("node:child_process"),
  fs = require("node:fs"),
  http = require("node:http"),
  os = require("node:os"),
  path = require("node:path"),
  vm = require("node:vm"),
  crypto = require("node:crypto"),
  { DatabaseSync } = require("node:sqlite");
const CT = require("../engine.js"),
  ctx = { window: {}, CT, crypto };
vm.runInNewContext(
  fs.readFileSync(require.resolve("../samples.js"), "utf8"),
  ctx,
);
const dir = fs.mkdtempSync(
  path.join(process.env.NEN_TEST_DIR || os.tmpdir(), "nen-test-"),
);
const proc = spawn(process.execPath, [require.resolve("../server.cjs")], {
  env: { ...process.env, PORT: "4187", NEN_DATA_DIR: dir },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
proc.stdout.on("data", (d) => (output += d));
proc.stderr.on("data", (d) => (output += d));
const base = "http://127.0.0.1:4187";
async function call(route, method = "GET", body, cookie = "", headers = {}) {
  const r = await fetch(base + route, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = r.headers.get("content-type") || "";
  return {
    status: r.status,
    body: type.includes("json") ? await r.json() : await r.text(),
    cookie: r.headers.get("set-cookie")?.split(";")[0],
  };
}
/** Low-level request with full control over Host/Origin/encoding headers and body chunking.
 * `chunks` are written one by one with `gap` ms between them. */
function raw(route, { method = "GET", headers = {}, chunks = [], gap = 0, port = 4187 } = {}) {
  return new Promise((resolve, reject) => {
    const length = chunks.reduce((n, c) => n + Buffer.byteLength(c), 0);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: route,
        method,
        headers: { ...(chunks.length ? { "Content-Length": length } : {}), ...headers },
      },
      (res) => {
        const parts = [];
        res.on("data", (d) => parts.push(d));
        res.on("end", () => {
          const body = Buffer.concat(parts);
          let json = null;
          try {
            json = JSON.parse(body.toString("utf8"));
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, body, json });
        });
      },
    );
    req.on("error", reject);
    (async () => {
      for (const chunk of chunks) {
        req.write(chunk);
        if (gap) await new Promise((r) => setTimeout(r, gap));
      }
      req.end();
    })();
  });
}
function waitForOutput(getOutput, needle = "đang chạy") {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (getOutput().includes(needle)) return resolve();
      if (Date.now() - start > 10000) return reject(Error(getOutput()));
      setTimeout(check, 100);
    };
    check();
  });
}
/** A second server bound to loopback but configured for a public host name: the first admin
 * must present the one-time setup token printed on the console. */
async function setupTokenChecks() {
  const tokenDir = fs.mkdtempSync(path.join(process.env.NEN_TEST_DIR || os.tmpdir(), "nen-test-token-"));
  const port = 4186;
  const second = spawn(process.execPath, [require.resolve("../server.cjs")], {
    env: { ...process.env, PORT: String(port), NEN_DATA_DIR: tokenDir, NEN_ALLOWED_HOSTS: "qlda.test:" + port },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  second.stdout.on("data", (d) => (log += d));
  second.stderr.on("data", (d) => (log += d));
  try {
    await waitForOutput(() => log, "?setup=");
    const token = log.match(/\?setup=([A-Za-z0-9_-]+)/)[1];
    const json = { "Content-Type": "application/json" };
    const me = await raw("/api/me", { port });
    assert.equal(me.json.setupTokenRequired, true);
    const form = JSON.stringify({ name: "Admin", email: "token@example.test", password: "Test-Only-45678" });
    // No token → refused, even from loopback.
    assert.equal((await raw("/api/setup", { port, method: "POST", headers: json, chunks: [form] })).status, 403);
    // Wrong token in the body → refused.
    const wrong = JSON.stringify({ ...JSON.parse(form), setupToken: "x".repeat(32) });
    assert.equal((await raw("/api/setup", { port, method: "POST", headers: json, chunks: [wrong] })).status, 403);
    // Configured public name is accepted, unknown names are not.
    assert.equal((await raw("/api/me", { port, headers: { Host: "qlda.test:" + port } })).status, 200);
    assert.equal((await raw("/api/me", { port, headers: { Host: "evil.test:" + port } })).status, 421);
    // The console link stores the token in a cookie scoped to /api/setup and redirects to "/".
    const link = await raw("/?setup=" + token, { port });
    assert.equal(link.status, 303);
    assert.equal(link.headers.location, "/");
    const setupCookie = link.headers["set-cookie"][0].split(";")[0];
    assert.match(link.headers["set-cookie"][0], /Path=\/api\/setup/);
    const created = await raw("/api/setup", {
      port,
      method: "POST",
      headers: { ...json, Cookie: setupCookie },
      chunks: [form],
    });
    assert.equal(created.status, 201, created.body.toString());
    assert.equal((await raw("/api/me", { port })).json.setupTokenRequired, false);
  } finally {
    second.kill();
    second.once("exit", () => fs.rmSync(tokenDir, { recursive: true, force: true }));
  }
}
(async () => {
  try {
    await waitForOutput(() => output);
    assert.equal((await call("/api/projects")).status, 401);
    assert.equal((await call("/.codex/config.toml")).status, 404);
    assert.equal((await call("/data/nen.sqlite")).status, 404);
    assert.equal((await call("/%E0%A4%A")).status, 404, "malformed escapes are a 404, not an error");

    // DNS rebinding: attacker.example resolves to 127.0.0.1, so Host and Origin agree with each
    // other — the server must still refuse because the name is not on the allowlist.
    const rebinding = await raw("/api/setup", {
      method: "POST",
      headers: {
        Host: "attacker.example:4187",
        Origin: "http://attacker.example:4187",
        "Content-Type": "application/json",
      },
      chunks: [JSON.stringify({ name: "Evil", email: "evil@example.test", password: "Test-Only-45678" })],
    });
    assert.equal(rebinding.status, 421);
    assert.equal((await raw("/", { headers: { Host: "attacker.example:4187" } })).status, 421);
    assert.equal((await raw("/api/me", { headers: { Host: "127.0.0.1:9999" } })).status, 421, "wrong port");
    assert.equal((await call("/api/me")).body.setup, true, "rebinding attempt must not create the admin");
    assert.equal((await call("/api/me")).body.setupTokenRequired, false, "loopback keeps the simple setup");

    const admin = await call("/api/setup", "POST", {
      name: "Admin QA",
      email: "admin@example.test",
      password: "Test-Only-45678",
    });
    assert.equal(admin.status, 201, JSON.stringify(admin.body));
    const a = admin.cookie;
    assert.ok(a);
    assert.equal(
      (
        await call("/api/setup", "POST", {
          name: "Other",
          email: "other@example.test",
          password: "Test-Only-45678",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call("/api/login", "POST", {
          email: "admin@example.test",
          password: "wrong-password",
        })
      ).status,
      401,
    );
    const p = ctx.window.Samples.construction();
    const create = await call("/api/projects", "POST", { project: p }, a);
    assert.equal(create.status, 201, JSON.stringify(create.body));
    const get = await call("/api/projects/" + p.id, "GET", null, a);
    assert.equal(get.body.project._version, 1);
    assert.equal((await call("/api/projects", "POST", { project: p }, a)).status, 409, "duplicate id");

    // Origin is compared with the allowlist, not with whatever Host says.
    const originCheck = (origin) => call("/api/projects", "POST", { project: null }, a, { Origin: origin });
    assert.equal((await originCheck("http://127.0.0.1:4187")).status, 400, "same origin passes to validation");
    assert.equal((await originCheck("http://localhost:4187")).status, 400, "loopback alias on our port");
    assert.equal((await originCheck("http://localhost:9999")).status, 403, "other local port");
    assert.equal((await originCheck("https://127.0.0.1:4187")).status, 403, "wrong scheme");
    assert.equal((await originCheck("null")).status, 403, "opaque origin");

    // Body parsing: exact media type, UTF-8 only, JSON object only.
    const post = (route, type, body) =>
      raw(route, { method: "POST", headers: { "Content-Type": type, Cookie: a }, chunks: [body] });
    assert.equal((await post("/api/projects", "application/json-evil", "{}")).status, 415);
    assert.equal((await post("/api/projects", "text/plain", "{}")).status, 415);
    assert.equal((await post("/api/projects", "application/json; charset=latin1", "{}")).status, 415);
    assert.equal((await post("/api/projects", "application/json; charset=utf-8", "{}")).status, 400);
    for (const body of ["null", "[]", "42", '"x"', "{bad", Buffer.from([0x7b, 0xff, 0x7d])]) {
      const r = await post("/api/login", "application/json", body);
      assert.equal(r.status, 400, "body " + body);
      assert.ok(r.json.error);
    }

    // A multi-byte character split across two TCP writes must survive (was saved as U+FFFD).
    const comment = "Kiểm tra tiếng Việt: ước lượng ổn định ✓";
    const bytes = Buffer.from(JSON.stringify({ body: comment }));
    const cut = bytes.indexOf(Buffer.from("ể")) + 1; // inside the 3-byte sequence
    const split = await raw("/api/projects/" + p.id + "/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: a },
      chunks: [bytes.subarray(0, cut), bytes.subarray(cut)],
      gap: 80,
    });
    assert.equal(split.status, 201, split.body.toString());
    assert.equal((await call("/api/projects/" + p.id + "/comments", "GET", null, a)).body.comments[0].body, comment);

    // Unexpected errors: generic 500 for the client, details only in the server log.
    const lock = new DatabaseSync(path.join(dir, "nen.sqlite"));
    lock.exec("BEGIN EXCLUSIVE");
    let locked;
    try {
      locked = await call("/api/projects/" + p.id + "/comments", "POST", { body: "khi khóa" }, a);
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
    }
    assert.equal(locked.status, 500);
    assert.equal(locked.body.error, "Máy chủ gặp lỗi nội bộ. Vui lòng thử lại sau.");
    assert.doesNotMatch(JSON.stringify(locked.body), /locked|sqlite/i);
    assert.match(output, /database is locked/);
    assert.equal((await call("/api/projects/" + p.id + "/comments", "POST", { body: "sau khi mở khóa" }, a)).status, 201);

    // Static files: ETag/Last-Modified revalidation, gzip negotiation, headers.
    const asset = "/vendor/purify.min.js";
    const js = await raw(asset, { headers: { "Accept-Encoding": "gzip, deflate" } });
    assert.equal(js.status, 200);
    assert.equal(js.headers["content-encoding"], "gzip");
    assert.equal(js.headers["cache-control"], "no-cache");
    assert.ok(js.headers.etag && js.headers["last-modified"]);
    assert.ok(js.headers["permissions-policy"]);
    const revalidated = await raw(asset, { headers: { "Accept-Encoding": "gzip", "If-None-Match": js.headers.etag } });
    assert.equal(revalidated.status, 304);
    assert.equal(revalidated.body.length, 0);
    assert.equal((await raw(asset, { headers: { "If-Modified-Since": js.headers["last-modified"] } })).status, 304);
    assert.equal((await raw(asset, { headers: { "If-None-Match": 'W/"other"' } })).status, 200);
    const identity = await raw(asset, { headers: { "Accept-Encoding": "gzip;q=0, br" } });
    assert.equal(identity.headers["content-encoding"], undefined, "q=0 refuses gzip");
    assert.equal(Number(identity.headers["content-length"]), identity.body.length);
    const png = await raw("/assets/hcmut-logo.png", { headers: { "Accept-Encoding": "gzip" } });
    assert.equal(png.status, 200);
    assert.equal(png.headers["content-encoding"], undefined, "PNG is not re-compressed");
    assert.match(png.headers["cache-control"], /max-age/);
    const head = await raw("/", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal((await raw("/", { method: "POST" })).status, 405);
    const malformed = structuredClone(p);
    malformed.tasks[0].duration = -1;
    assert.equal(
      (
        await call(
          "/api/projects/" + p.id,
          "PUT",
          { project: malformed, version: 1 },
          a,
        )
      ).status,
      400,
    );
    p.name = "QA updated";
    assert.equal(
      (
        await call(
          "/api/projects/" + p.id,
          "PUT",
          { project: p, version: 1 },
          a,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await call(
          "/api/projects/" + p.id,
          "PUT",
          { project: p, version: 1 },
          a,
        )
      ).status,
      409,
    );
    const viewer = await call(
      "/api/users",
      "POST",
      {
        name: "Viewer QA",
        email: "viewer@example.test",
        password: "Test-Only-45678",
      },
      a,
    );
    assert.equal(viewer.status, 201);
    const v = (
      await call("/api/login", "POST", {
        email: "viewer@example.test",
        password: "Test-Only-45678",
      })
    ).cookie;
    assert.equal(
      (await call("/api/projects/" + p.id, "GET", null, v)).status,
      403,
    );
    assert.equal(
      (
        await call(
          "/api/projects/" + p.id + "/members",
          "POST",
          { userId: viewer.body.user.id, role: "viewer" },
          a,
        )
      ).status,
      200,
    );
    assert.equal(
      (await call("/api/projects/" + p.id, "GET", null, v)).body.project._role,
      "viewer",
    );
    assert.equal(
      (
        await call(
          "/api/projects/" + p.id,
          "PUT",
          { project: p, version: 2 },
          v,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          "/api/projects/" + p.id + "/members",
          "POST",
          { userId: viewer.body.user.id, role: "owner" },
          v,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          "/api/users",
          "POST",
          { name: "No", email: "no@example.test", password: "Test-Only-45678" },
          v,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          "/api/projects/" + p.id + "/members",
          "POST",
          { userId: viewer.body.user.id, role: "editor" },
          a,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await call(
          "/api/projects/" + p.id,
          "PUT",
          { project: p, version: 2 },
          v,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await call(
          "/api/projects/" + p.id,
          "PUT",
          { project: p, version: 3 },
          v,
          { Origin: "https://other.example" },
        )
      ).status,
      403,
    );

    // /api/users: admins see every account, others only people they share a project with.
    const stranger = await call(
      "/api/users",
      "POST",
      { name: "Stranger QA", email: "stranger@example.test", password: "Test-Only-45678" },
      a,
    );
    assert.equal(stranger.status, 201);
    const emails = async (cookie) =>
      (await call("/api/users", "GET", null, cookie)).body.users.map((u) => u.email).sort();
    assert.deepEqual(await emails(v), ["admin@example.test", "viewer@example.test"]);
    assert.ok((await emails(a)).includes("stranger@example.test"));
    const s = (
      await call("/api/login", "POST", { email: "stranger@example.test", password: "Test-Only-45678" })
    ).cookie;
    assert.deepEqual(await emails(s), ["stranger@example.test"]);
    // …and cannot add accounts they cannot see (no id probing through the member endpoint).
    const strangerProject = ctx.window.Samples.construction();
    assert.equal((await call("/api/projects", "POST", { project: strangerProject }, s)).status, 201);
    assert.equal(
      (
        await call(
          "/api/projects/" + strangerProject.id + "/members",
          "POST",
          { userId: viewer.body.user.id, role: "viewer" },
          s,
        )
      ).status,
      400,
    );

    // Audit text is written by the server; the client's history text is only a labelled note.
    p.name = "QA audit";
    p.history = [{ text: "Quản trị viên đã xóa toàn bộ dữ liệu", at: "2000-01-01T00:00:00Z", actor: "Giả mạo" }];
    const audited = await call("/api/projects/" + p.id, "PUT", { project: p, version: 3 }, a);
    assert.equal(audited.status, 200, JSON.stringify(audited.body));
    assert.equal(audited.body.version, 4);
    const latest = (await call("/api/projects/" + p.id + "/audit", "GET", null, a)).body.events[0];
    assert.equal(latest.action, "Cập nhật dự án (phiên bản 4)");
    assert.equal(latest.note, "Quản trị viên đã xóa toàn bộ dữ liệu");
    assert.equal(latest.actor, "Admin QA");
    const stored = (await call("/api/projects/" + p.id, "GET", null, a)).body.project.history[0];
    assert.equal(stored.actor, "Admin QA");
    assert.notEqual(stored.at, "2000-01-01T00:00:00Z");

    // Passwords are no longer trimmed; legacy (trimmed) hashes still log in.
    const spaced = "  Spaced-pass-123  ";
    assert.equal(
      (await call("/api/users", "POST", { name: "Spaced", email: "spaced@example.test", password: spaced }, a)).status,
      201,
    );
    assert.equal((await call("/api/login", "POST", { email: "spaced@example.test", password: spaced })).status, 200);
    assert.equal(
      (await call("/api/login", "POST", { email: "spaced@example.test", password: spaced.trim() })).status,
      401,
    );
    const legacySalt = crypto.randomBytes(16).toString("hex"),
      legacyDb = new DatabaseSync(path.join(dir, "nen.sqlite"));
    legacyDb
      .prepare("INSERT INTO users(name,email,salt,hash,admin) VALUES(?,?,?,?,0)")
      .run("Legacy", "legacy@example.test", legacySalt, crypto.scryptSync("Legacy-pass-123", legacySalt, 64).toString("hex"));
    legacyDb.close();
    for (const password of [" Legacy-pass-123 ", "Legacy-pass-123"])
      assert.equal((await call("/api/login", "POST", { email: "legacy@example.test", password })).status, 200);

    // Repeated failures for one address+account back off (short, not a permanent lock).
    for (let i = 0; i < 5; i++)
      assert.equal(
        (await call("/api/login", "POST", { email: "nobody@example.test", password: "wrong-password-" + i })).status,
        401,
      );
    const limited = await raw("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      chunks: [JSON.stringify({ email: "nobody@example.test", password: "wrong-password" })],
    });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers["retry-after"]) >= 1 && Number(limited.headers["retry-after"]) <= 2);

    await setupTokenChecks();
    assert.ok(
      (await call("/api/projects/" + p.id + "/audit", "GET", null, a)).body
        .events.length >= 5,
    );
    await call("/api/logout", "POST", {}, v);
    assert.equal((await call("/api/projects", "GET", null, v)).status, 401);
    console.log(
      "✓ Tài khoản, session, xác thực đầu vào, riêng tư dự án, viewer/editor/owner, chống ghi đè, Origin, nhật ký và đăng xuất đạt.",
    );
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    proc.kill();
    proc.once("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  }
})();
