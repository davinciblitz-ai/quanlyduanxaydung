/* Đóng gói bản tĩnh (chế độ Cá nhân) vào dist/ để đưa lên Cloudflare Pages hoặc host tĩnh bất kỳ.
 * Danh sách file lấy đúng từ PUBLIC_FILES của server.cjs để hai nơi không lệch nhau.
 * Chế độ đội dự án cần server.cjs (Node + SQLite) nên không có trong bản tĩnh; app tự nhận ra
 * khi /api/me không trả JSON và chỉ dùng dữ liệu trên trình duyệt. */
"use strict";
const fs = require("node:fs"), path = require("node:path");
const root = path.resolve(__dirname, ".."), out = path.join(root, "dist");
const server = fs.readFileSync(path.join(root, "server.cjs"), "utf8");
const block = server.match(/const PUBLIC_FILES = new Set\(\[([\s\S]*?)\]\);/);
if (!block) throw Error("Không tìm thấy PUBLIC_FILES trong server.cjs");
const files = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

fs.rmSync(out, { recursive: true, force: true });
for (const file of files) {
  const from = path.join(root, file), to = path.join(out, file);
  if (!fs.existsSync(from)) throw Error("Thiếu file công khai: " + file);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}
// Cùng chính sách bảo mật với server.cjs.
fs.writeFileSync(
  path.join(out, "_headers"),
  [
    "/*",
    "  X-Content-Type-Options: nosniff",
    "  X-Frame-Options: DENY",
    "  Referrer-Policy: same-origin",
    "  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    "  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "/vendor/*",
    "  Cache-Control: public, max-age=86400",
    "/assets/*",
    "  Cache-Control: public, max-age=86400",
    "",
  ].join("\n"),
);
console.log("Đã đóng gói " + files.length + " file vào " + path.relative(root, out) + "/");
