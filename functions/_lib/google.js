// Xác thực Google ID token (đăng nhập "Sign in with Google") bằng Web Crypto.
// Không cần client secret: token do Google ký RS256, kiểm bằng khóa công khai (JWKS) của Google.
// Tài liệu: https://developers.google.com/identity/gsi/web/guides/verify-google-id-token

export const GOOGLE_CERTS = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const SKEW = 300; // giây cho phép lệch đồng hồ

let cache = { keys: null, until: 0 };

function base64UrlBytes(part) {
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
  const bin = atob(b64), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function base64UrlJson(part) {
  return JSON.parse(new TextDecoder().decode(base64UrlBytes(part)));
}

/** Khóa công khai của Google, giữ theo Cache-Control max-age của Google. */
export async function googleKeys(fetchImpl = fetch, now = Date.now()) {
  if (cache.keys && now < cache.until) return cache.keys;
  const res = await fetchImpl(GOOGLE_CERTS);
  if (!res.ok) throw new Error("Không tải được khóa xác thực của Google.");
  const body = await res.json();
  const maxAge = Number((res.headers.get("cache-control") || "").match(/max-age=(\d+)/)?.[1] || 3600);
  cache = { keys: body.keys || [], until: now + Math.min(maxAge, 86400) * 1000 };
  return cache.keys;
}

/**
 * Trả về thông tin người dùng nếu token hợp lệ; ném lỗi (thông điệp tiếng Việt) nếu không.
 * keys: mảng JWK (mặc định tải từ Google); now: mili giây (cho kiểm thử).
 */
export async function verifyGoogleIdToken(token, { clientId, keys, now = Date.now() } = {}) {
  if (!clientId) throw new Error("Máy chủ chưa cấu hình GOOGLE_CLIENT_ID.");
  if (typeof token !== "string" || token.length > 4096) throw new Error("Token đăng nhập không hợp lệ.");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Token đăng nhập không hợp lệ.");
  let header, claims;
  try {
    header = base64UrlJson(parts[0]);
    claims = base64UrlJson(parts[1]);
  } catch {
    throw new Error("Token đăng nhập không hợp lệ.");
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("Token đăng nhập không hợp lệ.");
  const jwk = (keys || (await googleKeys())).find((k) => k.kid === header.kid && k.kty === "RSA");
  if (!jwk) throw new Error("Khóa ký của token không còn hiệu lực. Hãy đăng nhập lại.");
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signed = new TextEncoder().encode(parts[0] + "." + parts[1]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64UrlBytes(parts[2]), signed);
  if (!ok) throw new Error("Chữ ký token không hợp lệ.");
  const seconds = Math.floor(now / 1000);
  if (!ISSUERS.has(claims.iss)) throw new Error("Token không do Google cấp.");
  if (claims.aud !== clientId) throw new Error("Token không dành cho ứng dụng này.");
  if (!(Number(claims.exp) > seconds - SKEW)) throw new Error("Phiên đăng nhập Google đã hết hạn. Hãy đăng nhập lại.");
  if (Number(claims.iat) > seconds + SKEW) throw new Error("Token đăng nhập không hợp lệ.");
  if (typeof claims.sub !== "string" || !claims.sub) throw new Error("Token thiếu mã tài khoản.");
  if (typeof claims.email !== "string" || claims.email_verified !== true && claims.email_verified !== "true")
    throw new Error("Email Google chưa được xác minh.");
  return {
    sub: claims.sub,
    email: claims.email.toLowerCase(),
    name: (typeof claims.name === "string" && claims.name.trim()) || claims.email.split("@")[0],
    picture: typeof claims.picture === "string" && /^https:\/\//.test(claims.picture) ? claims.picture : null,
  };
}
