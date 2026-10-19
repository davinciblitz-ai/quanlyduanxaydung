// Kiểm thử API nhóm trên Cloudflare (functions/ + D1) qua máy chủ thử cục bộ.
// Chạy:  npm run build:static && npx wrangler d1 migrations apply qlda --local
//        npx wrangler pages dev --port 8788      (cần .dev.vars có DEV_LOGIN=1)
//        node tests/cloudflare-api.test.cjs [http://127.0.0.1:8788]
const assert = require("node:assert/strict"), vm = require("node:vm"), fs = require("node:fs"), crypto = require("node:crypto");
const BASE = process.argv[2] || "http://127.0.0.1:8788";
const CT = require("../engine.js");
const context = { window: {}, CT, crypto };
vm.runInNewContext(fs.readFileSync(require.resolve("../samples.js"), "utf8"), context);
const Samples = context.window.Samples;
const run = Date.now().toString(36);

/** Một "trình duyệt" giữ cookie riêng. */
function client(label) {
  let session = "";
  return {
    label,
    async call(path, method = "GET", body, headers = {}) {
      const res = await fetch(BASE + path, {
        method,
        headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(session ? { Cookie: session } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get("set-cookie");
      if (set) session = set.split(";")[0].endsWith("=") ? "" : set.split(";")[0];
      let data = null;
      try {
        data = await res.json();
      } catch {}
      return { status: res.status, data };
    },
  };
}
let count = 0;
async function test(name, fn) {
  await fn();
  count++;
  console.log("✓ " + name);
}

(async () => {
  const owner = client("owner"), mate = client("mate"), viewer = client("viewer"), stranger = client("stranger");
  const mail = (who) => `${who}.${run}@gmail.com`;
  const project = { ...Samples.exerciseAK(), id: "cf-" + run };

  await test("Chưa đăng nhập: /api/me báo dùng Google, API khác trả 401", async () => {
    const me = await owner.call("/api/me");
    assert.equal(me.status, 200);
    assert.equal(me.data.auth, "google");
    assert.equal(me.data.user, null);
    assert.equal((await owner.call("/api/projects")).status, 401);
  });

  await test("Token Google giả bị từ chối", async () => {
    const r = await owner.call("/api/auth/google", "POST", { credential: "a.b.c" });
    assert.ok([401].includes(r.status), JSON.stringify(r));
  });

  await test("Đăng nhập thử (chỉ localhost), tạo dự án, chủ dự án là owner", async () => {
    assert.equal((await owner.call("/api/auth/dev", "POST", { email: mail("owner"), name: "Chủ nhóm" })).status, 200);
    const created = await owner.call("/api/projects", "POST", { project });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const list = await owner.call("/api/projects");
    const mine = list.data.projects.find((p) => p.id === project.id);
    assert.equal(mine._role, "owner");
    assert.equal(mine._version, 1);
    assert.equal(mine._owner, "Chủ nhóm");
    assert.equal((await owner.call("/api/projects", "POST", { project })).status, 409);
  });

  await test("Dữ liệu sai bị chặn bằng cùng bộ kiểm tra của engine", async () => {
    const bad = { ...project, id: "cf-bad-" + run, tasks: [{ ...project.tasks[0], duration: -1 }] };
    const r = await owner.call("/api/projects", "POST", { project: bad });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /thời lượng/);
  });

  await test("Mời theo Gmail người chưa đăng nhập: chờ; đăng nhập lần đầu là thành viên", async () => {
    let r = await owner.call(`/api/projects/${project.id}/members`, "POST", { email: mail("mate").toUpperCase(), role: "editor" });
    assert.equal(r.status, 200);
    assert.equal(r.data.pending, true);
    r = await owner.call(`/api/projects/${project.id}/members`);
    assert.deepEqual(r.data.pending.map((x) => x.email), [mail("mate")]);
    await mate.call("/api/auth/dev", "POST", { email: mail("mate"), name: "Bạn cùng nhóm" });
    const list = await mate.call("/api/projects");
    assert.equal(list.data.projects.find((p) => p.id === project.id)?._role, "editor");
    r = await owner.call(`/api/projects/${project.id}/members`);
    assert.equal(r.data.pending.length, 0);
    assert.equal(r.data.members.length, 2);
  });

  await test("Mời Gmail đã có tài khoản: thêm ngay; viewer không sửa được", async () => {
    await viewer.call("/api/auth/dev", "POST", { email: mail("viewer"), name: "Người xem" });
    const r = await owner.call(`/api/projects/${project.id}/members`, "POST", { email: mail("viewer"), role: "viewer" });
    assert.equal(r.data.pending, false);
    const got = await viewer.call(`/api/projects/${project.id}`);
    assert.equal(got.data.project._role, "viewer");
    const put = await viewer.call(`/api/projects/${project.id}`, "PUT", { project: got.data.project, version: got.data.project._version });
    assert.equal(put.status, 403);
    assert.equal((await viewer.call(`/api/projects/${project.id}/comments`, "POST", { body: "xem thôi" })).status, 403);
  });

  await test("Người ngoài không thấy dự án", async () => {
    await stranger.call("/api/auth/dev", "POST", { email: mail("stranger"), name: "Người lạ" });
    assert.equal((await stranger.call(`/api/projects/${project.id}`)).status, 403);
    assert.equal((await stranger.call("/api/projects")).data.projects.some((p) => p.id === project.id), false);
  });

  await test("Hai người sửa cùng lúc: người sau nhận 409, /version báo ai vừa sửa", async () => {
    const a = (await owner.call(`/api/projects/${project.id}`)).data.project;
    const b = (await mate.call(`/api/projects/${project.id}`)).data.project;
    a.history = [{ text: "Chủ nhóm sửa thời lượng A", at: new Date().toISOString() }];
    a.tasks[0].duration = 5;
    a.tasks[0].minDuration = 5;
    const first = await owner.call(`/api/projects/${project.id}`, "PUT", { project: a, version: a._version });
    assert.equal(first.status, 200, JSON.stringify(first.data));
    b.tasks[1].name = "Sửa song song";
    assert.equal((await mate.call(`/api/projects/${project.id}`, "PUT", { project: b, version: b._version })).status, 409);
    const v = await mate.call(`/api/projects/${project.id}/version`);
    assert.equal(v.data.version, first.data.version);
    assert.equal(v.data.by, "Chủ nhóm");
    assert.equal(v.data.byMe, false);
    const fresh = (await mate.call(`/api/projects/${project.id}`)).data.project;
    assert.equal(fresh.tasks[0].duration, 5);
    assert.equal(fresh.history[0].actor, "Chủ nhóm");
  });

  await test("Liên kết mời một lần, bình luận, nhật ký do máy chủ ghi", async () => {
    const inv = await owner.call(`/api/projects/${project.id}/invites`, "POST", { role: "commenter" });
    assert.equal(inv.status, 201);
    assert.equal((await stranger.call(`/api/invites/${inv.data.token}`)).data.role, "commenter");
    assert.equal((await stranger.call(`/api/invites/${inv.data.token}`, "POST", {})).status, 200);
    assert.equal((await mate.call(`/api/invites/${inv.data.token}`, "POST", {})).status, 404);
    assert.equal((await stranger.call(`/api/projects/${project.id}/comments`, "POST", { body: "Góp ý: kiểm tra lại K" })).status, 201);
    const comments = await owner.call(`/api/projects/${project.id}/comments`);
    assert.equal(comments.data.comments[0].author, "Người lạ");
    const audit = await owner.call(`/api/projects/${project.id}/audit`);
    assert.ok(audit.data.events.some((e) => /phiên bản 2/.test(e.action) && e.note === "Chủ nhóm sửa thời lượng A"));
  });

  await test("Chặn yêu cầu từ trang khác (Origin) và kiểu nội dung không phải JSON", async () => {
    assert.equal((await owner.call(`/api/projects/${project.id}/comments`, "POST", { body: "x" }, { Origin: "https://evil.example" })).status, 403);
    const res = await fetch(BASE + `/api/projects/${project.id}/comments`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" });
    assert.ok([401, 415].includes(res.status));
  });

  await test("Gỡ thành viên, rời dự án; xóa và khôi phục chỉ chủ gốc", async () => {
    const members = (await owner.call(`/api/projects/${project.id}/members`)).data.members;
    const viewerId = members.find((m) => m.email === mail("viewer")).id;
    assert.equal((await mate.call(`/api/projects/${project.id}/members/${viewerId}`, "DELETE", {})).status, 403);
    assert.equal((await owner.call(`/api/projects/${project.id}/members/${viewerId}`, "DELETE", {})).status, 200);
    assert.equal((await viewer.call(`/api/projects/${project.id}`)).status, 403);
    const v = (await owner.call(`/api/projects/${project.id}/version`)).data.version;
    assert.equal((await mate.call(`/api/projects/${project.id}`, "DELETE", { version: v })).status, 403);
    assert.equal((await owner.call(`/api/projects/${project.id}`, "DELETE", { version: v })).status, 200);
    assert.equal((await mate.call(`/api/projects/${project.id}`)).status, 404);
    assert.ok((await owner.call("/api/deleted-projects")).data.projects.some((p) => p.id === project.id));
    assert.equal((await owner.call(`/api/projects/${project.id}/restore`, "POST", {})).status, 200);
    assert.equal((await mate.call(`/api/projects/${project.id}`)).status, 200);
  });

  await test("Đăng xuất hủy phiên trên máy chủ", async () => {
    assert.equal((await mate.call("/api/logout", "POST", {})).status, 200);
    assert.equal((await mate.call("/api/projects")).status, 401);
  });

  console.log(`\n${count} nhóm kiểm thử API nhóm (Cloudflare) đạt.`);
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
