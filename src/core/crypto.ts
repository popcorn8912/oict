import { createHash, randomBytes } from "node:crypto";

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
