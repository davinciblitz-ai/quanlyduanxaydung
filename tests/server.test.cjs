"use strict";
const assert = require("node:assert/strict"),
  { spawn } = require("node:child_process"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  vm = require("node:vm"),
  crypto = require("node:crypto");
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
(async () => {
  try {
    await new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (output.includes("đang chạy")) return resolve();
        if (Date.now() - start > 10000) return reject(Error(output));
        setTimeout(check, 100);
      };
      check();
    });
    assert.equal((await call("/api/projects")).status, 401);
    assert.equal((await call("/.codex/config.toml")).status, 404);
    assert.equal((await call("/data/nen.sqlite")).status, 404);
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
  }
})();
