# 07 · Security Considerations

**Token secrets.** Confirmation tokens are only as strong as the key that signs them. Deployments **MUST** keep signing keys in a managed secret store, **SHOULD** rotate them, and **SHOULD** use asymmetric signatures (JWS) when tokens must be verified by a party other than the issuer.

**Replay.** Single-use nonces (IDM-4) and short expiry (STB-6) limit replay. The nonce store **MUST** be shared by every instance that can place orders; otherwise a replay can succeed on a different node.

**Clock skew.** Expiry checks depend on clocks. Services **SHOULD** use a monotonic, NTP-disciplined clock and **MAY** allow a small skew (≤ 5 s).

**Client-supplied data.** The client supplies *identifiers* (scene object, SKU, variant, quantity) and the *hash it rendered*. It never supplies prices or totals (STB-4). A client that lies about the hash only causes its own request to fail.

**Agent prompt injection.** An agent can be manipulated by content it reads. AGT-1 ensures that even a fully compromised agent cannot place an order; the worst case is a draft cart the consumer still has to confirm.

**Privacy.** Snapshots contain product identifiers, not personal data. Grants and orders contain participant identifiers; deployments **SHOULD** use pseudonymous identifiers in logs and **MUST** follow applicable privacy law, including laws specific to children's data.

**Denial of service.** Idempotency and nonce stores grow with traffic. Records **SHOULD** expire after their retention window, and request bodies **SHOULD** be size-limited (the reference server accepts at most 64 KiB).

**Reference server scope.** The reference server keeps all state in memory, uses a per-process secret, and identifies grants with a simplified header. It is a correctness reference and a conformance target, **not** a production service.
