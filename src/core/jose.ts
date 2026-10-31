/**
 * Minimal JOSE for OICT: compact JWS (RFC 7515) with EdDSA / Ed25519 (RFC 8037),
 * JWK thumbprints (RFC 7638) and JWK Sets.
 *
 * Deliberately strict:
 *   • the only accepted algorithm is EdDSA — "none" and HMAC algorithms are
 *     refused, which rules out algorithm-confusion attacks;
 *   • every token must name its key (`kid`) and its type (`typ`), so an access
 *     token can never be replayed as a confirmation or vice versa.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalJson } from "./crypto.ts";

export const TOKEN_TYPES = {
  confirmation: "oict-confirmation+jwt",
  access: "at+jwt",
} as const;
export type TokenType = (typeof TOKEN_TYPES)[keyof typeof TOKEN_TYPES];

export interface PublicJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  kid: string;
  use: "sig";
  alg: "EdDSA";
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const unb64u = (s: string) => Buffer.from(s, "base64url");

/** RFC 7638 thumbprint of an Ed25519 public key. */
export function thumbprint(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: "jwk" }) as { crv: string; kty: string; x: string };
  const members = canonicalJson({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return createHash("sha256").update(members).digest("base64url");
}

function toPublicJwk(publicKey: KeyObject): PublicJwk {
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  return { kty: "OKP", crv: "Ed25519", x: jwk.x, kid: thumbprint(publicKey), use: "sig", alg: "EdDSA" };
}

// PKCS#8 prefix for a raw 32-byte Ed25519 seed.
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** Accepts a 64-character hex seed, a base64/base64url 32-byte seed, or a PEM private key. */
export function loadSigningKey(raw: string): KeyObject {
  const text = raw.trim();
  if (text.startsWith("-----BEGIN")) {
    const key = createPrivateKey(text);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("signing key must be an Ed25519 private key");
    return key;
  }
  const seed = /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, "hex") : Buffer.from(text, "base64url");
  if (seed.length !== 32) throw new Error("signing key must be a 32-byte Ed25519 seed (64 hex characters) or a PEM private key");
  return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
}

/**
 * One signing key plus every public key this service accepts. Additional
 * verification keys come from a JWK Set: the previous key during rotation, or
 * an external authorization server that issues access tokens.
 */
export class KeyRing {
  readonly signingKid: string;
  private readonly signer: KeyObject;
  private readonly verifiers = new Map<string, KeyObject>();
  private readonly published: PublicJwk[] = [];

  constructor(signer: KeyObject, extraJwks: { keys: ReadonlyArray<{ kty?: unknown; crv?: unknown; x?: unknown; kid?: unknown }> } = { keys: [] }) {
    this.signer = signer;
    const pub = createPublicKey(signer);
    const own = toPublicJwk(pub);
    this.signingKid = own.kid;
    this.verifiers.set(own.kid, pub);
    this.published.push(own);
    for (const k of extraJwks.keys ?? []) {
      if (k.kty !== "OKP" || k.crv !== "Ed25519" || typeof k.x !== "string") continue;
      const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: k.x }, format: "jwk" });
      const kid = typeof k.kid === "string" ? k.kid : thumbprint(key);
      if (this.verifiers.has(kid)) continue;
      this.verifiers.set(kid, key);
      this.published.push({ ...toPublicJwk(key), kid });
    }
  }

  /** A fresh random key: fine for one in-memory instance, never for a fleet. */
  static ephemeral(): KeyRing {
    return new KeyRing(generateKeyPairSync("ed25519").privateKey);
  }

  static fromEnv(env: NodeJS.ProcessEnv): KeyRing | undefined {
    const raw = env.OICT_SIGNING_KEY_FILE ? readFileSync(env.OICT_SIGNING_KEY_FILE, "utf8") : env.OICT_SIGNING_KEY ?? env.OICT_SECRET;
    if (!raw) return undefined;
    const extra = env.OICT_TRUSTED_JWKS_FILE ? JSON.parse(readFileSync(env.OICT_TRUSTED_JWKS_FILE, "utf8")) : undefined;
    return new KeyRing(loadSigningKey(raw), extra);
  }

  jwks(): { keys: PublicJwk[] } {
    return { keys: this.published.map((k) => ({ ...k })) };
  }

  sign(typ: TokenType, payload: object): string {
    const header = { alg: "EdDSA", typ, kid: this.signingKid };
    const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
    return `${input}.${b64u(sign(null, Buffer.from(input), this.signer))}`;
  }

  /** Returns the payload when the signature, algorithm, key and type all check out; otherwise null. */
  verify<T>(typ: TokenType, token: string): T | null {
    if (typeof token !== "string" || token.length > 8192) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [h, p, s] = parts as [string, string, string];
    let header: { alg?: string; typ?: string; kid?: string; crit?: unknown };
    let payload: T;
    try {
      header = JSON.parse(unb64u(h).toString("utf8"));
      payload = JSON.parse(unb64u(p).toString("utf8"));
    } catch {
      return null;
    }
    if (header.alg !== "EdDSA" || header.typ !== typ || typeof header.kid !== "string" || header.crit !== undefined) return null;
    const key = this.verifiers.get(header.kid);
    if (!key) return null;
    const sig = unb64u(s);
    if (sig.length !== 64) return null;
    if (!verify(null, Buffer.from(`${h}.${p}`), key, sig)) return null;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
    return payload;
  }
}
