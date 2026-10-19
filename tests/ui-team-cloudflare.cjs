// Kiểm thử trình duyệt hai người dùng trên bản Cloudflare chạy cục bộ (wrangler pages dev, DEV_LOGIN=1).
// Chạy: node tests/ui-team-cloudflare.cjs [http://localhost:8788]
const { chromium } = require("playwright"), assert = require("node:assert/strict");
const BASE = process.argv[2] || "http://localhost:8788";
const run = Date.now().toString(36);

async function signIn(page, email, name) {
  await page.goto(BASE + "/");
  await page.waitForFunction(() => window.Nen);
  await page.locator(".mode-quick [data-mode=business]").click();
  await page.waitForSelector("#main h1");
  await page.waitForFunction(() => document.querySelector("#portfolio-google"), null, { timeout: 15000 });
  await page.locator("[data-action=team-connect]").first().click();
  await page.locator("#f-devEmail").fill(email);
  await page.locator("#f-devName").fill(name);
  await page.locator("#modal-submit").click();
  await page.waitForFunction(() => document.querySelector("#main h1")?.textContent.includes("Dự án nhóm"), null, { timeout: 15000 });
}

(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.PW_CHANNEL || (process.platform === "win32" ? "msedge" : undefined) });
  const errors = [];
  try {
    const a = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
    const b = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
    for (const p of [a, b]) p.on("pageerror", (e) => errors.push(e.message));
    const mailA = `chunhom.${run}@gmail.com`, mailB = `banhoc.${run}@gmail.com`;

    await signIn(a, mailA, "Chủ nhóm");
    // Dự án trên trình duyệt (bài A–K) → đưa lên nhóm → hộp thành viên mở ra.
    const share = a.locator(".project-card-wrap", { hasText: "11 công tác A–K" }).locator("[data-share-project]").last();
    await share.click();
    await a.waitForSelector("#f-memberEmail", { timeout: 15000 });
    await a.locator("#f-memberEmail").fill(mailB);
    await a.locator("#f-memberRole").selectOption("editor");
    await a.locator("#modal-submit").click();
    await a.waitForSelector(".member-row.pending", { timeout: 15000 });
    assert.ok((await a.locator(".member-list").textContent()).includes(mailB), "lời mời Gmail đang chờ");
    await a.locator("#modal [data-action=close-modal], #modal .modal-close").first().click().catch(() => a.keyboard.press("Escape"));
    await a.keyboard.press("Escape");

    await signIn(b, mailB, "Bạn học");
    const card = b.locator(".project-card[data-open-project]", { hasText: "11 công tác A–K" });
    assert.ok(await card.count(), "B thấy dự án được mời");
    assert.ok((await card.textContent()).includes("CHỈNH SỬA"), "B có quyền chỉnh sửa");
    await card.first().click();
    await b.locator("#side-nav [data-page=schedule]").click();
    await b.locator("[data-schedule-tab=tasks]").first().click();
    await b.locator("tr[data-edit-task=K]").click();
    await b.locator("#f-duration").fill("11");
    await b.locator("#modal-submit").click();
    await b.waitForFunction(() => !document.querySelector("#modal").open);
    assert.equal(await b.evaluate(() => Nen.getState().project.tasks.find((t) => t.id === "K").duration), 11);

    // A đang mở cùng dự án: tự tải bản mới trong ~12 s mà không cần bấm gì.
    await a.locator(".project-card[data-open-project]", { hasText: "11 công tác A–K" }).first().click();
    await a.waitForFunction(() => Nen.getState().project.tasks.find((t) => t.id === "K")?.duration === 11, null, { timeout: 30000 });
    assert.ok((await a.locator("#toast").textContent()).includes("Bạn học"), "A được báo ai vừa sửa");
    assert.deepEqual(errors, []);
    console.log("PASS hai người dùng: đưa dự án lên nhóm, mời bằng Gmail, người được mời sửa, người kia tự cập nhật.");
  } catch (e) {
    console.error(e);
    console.log("errors", errors);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
