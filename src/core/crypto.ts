import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Canonical JSON: object keys sorted recursively, no insignificant whitespace,
 * `undefined` members dropped. Two semantically equal snapshots always produce
 * the same bytes, so their hashes can be compared across services.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** `sha256:<hex>` over the canonical JSON form. */
export function digest(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

export function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

function b64u(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function unb64u(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

/** Compact signed token: base64url(claims) + "." + base64url(HMAC-SHA256). */
export function signToken(claims: object, secret: Buffer): string {
  const body = b64u(canonicalJson(claims));
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `oict1.${body}.${mac}`;
}

export function verifyToken<T>(token: string, secret: Buffer): T | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "oict1") return null;
  const [, body, mac] = parts as [string, string, string];
  const expected = createHmac("sha256", secret).update(body).digest();
  let given: Buffer;
  try {
    given = Buffer.from(mac, "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    return JSON.parse(unb64u(body)) as T;
  } catch {
    return null;
  }
}
