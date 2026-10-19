// Kiểm chữ ký và các điều kiện của Google ID token bằng khóa RSA tự tạo (không gọi mạng).
const assert = require("node:assert/strict");
const { webcrypto: crypto } = require("node:crypto");

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const enc = (obj) => b64url(Buffer.from(JSON.stringify(obj)));

(async () => {
  const { verifyGoogleIdToken } = await import("../functions/_lib/google.js");
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const other = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const clientId = "test-client.apps.googleusercontent.com", now = Date.UTC(2026, 9, 19, 8, 0, 0);
  const base = { iss: "https://accounts.google.com", aud: clientId, sub: "1234567890", email: "Ban.Nhom@Gmail.com", email_verified: true, name: "Bạn Nhóm", picture: "https://lh3.googleusercontent.com/a/x", iat: now / 1000 - 10, exp: now / 1000 + 3600 };
  async function sign(claims, key = pair.privateKey, header = { alg: "RS256", kid: "k1", typ: "JWT" }) {
    const data = enc(header) + "." + enc(claims);
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(data));
    return data + "." + b64url(new Uint8Array(sig));
  }
  const verify = (token, opts = {}) => verifyGoogleIdToken(token, { clientId, keys: [jwk], now, ...opts });

  const user = await verify(await sign(base));
  assert.deepEqual(user, { sub: "1234567890", email: "ban.nhom@gmail.com", name: "Bạn Nhóm", picture: "https://lh3.googleusercontent.com/a/x" });
  console.log("✓ Token hợp lệ: lấy sub, Gmail (chữ thường), tên và ảnh đại diện.");

  const cases = [
    ["ký bằng khóa khác", await sign(base, other.privateKey), /Chữ ký/],
    ["sửa nội dung sau khi ký", (await sign(base)).replace(/\.[^.]+\./, "." + enc({ ...base, email: "attacker@gmail.com" }) + "."), /Chữ ký/],
    ["sai ứng dụng (aud)", await sign({ ...base, aud: "other-app" }), /không dành cho ứng dụng/],
    ["sai nơi cấp (iss)", await sign({ ...base, iss: "https://evil.example" }), /không do Google/],
    ["hết hạn", await sign({ ...base, exp: now / 1000 - 3600 }), /hết hạn/],
    ["email chưa xác minh", await sign({ ...base, email_verified: false }), /chưa được xác minh/],
    ["thuật toán none", enc({ alg: "none", kid: "k1" }) + "." + enc(base) + ".", /không hợp lệ/],
    ["khóa không có trong JWKS", await sign(base, pair.privateKey, { alg: "RS256", kid: "khac" }), /Khóa ký/],
    ["chuỗi rác", "abc", /không hợp lệ/],
  ];
  for (const [name, token, message] of cases) await assert.rejects(verify(token), message, name);
  await assert.rejects(verifyGoogleIdToken(await sign(base), { clientId: "", keys: [jwk], now }), /GOOGLE_CLIENT_ID/);
  console.log("✓ Từ chối token giả mạo, sửa nội dung, sai ứng dụng, sai nơi cấp, hết hạn, email chưa xác minh, alg none.");
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
