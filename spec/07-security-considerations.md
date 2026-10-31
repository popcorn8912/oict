# 07 · Security Considerations

**Signing keys.** Confirmations and access tokens are only as strong as the keys that sign them. Deployments **MUST** keep private keys in a managed secret store and **SHOULD** rotate them, publishing the previous public key until its tokens have expired (STB-9). Because signatures are asymmetric, anyone can verify a confirmation from the published keys, but only the service can issue one.

**Audit trail.** A service **SHOULD** record, append-only, every grant issued or revoked, every draft cart, every order and every refused order attempt, with the acting participant and the consumer it acted for. The order record **SHOULD** be written atomically with the order itself, so the trail cannot miss a purchase. The reference server stores this in an `audit_events` table guarded by a database trigger that refuses updates and deletes, and lets a consumer's authorized application read the consumer's own trail.

**Replay.** Single-use nonces (IDM-4) and short expiry (STB-6) limit replay. The nonce store **MUST** be shared by every instance that can place orders; otherwise a replay can succeed on a different node. The reference server meets this with a primary key in PostgreSQL; see [docs/deployment.md](../docs/deployment.md).

**Check-then-write races.** A service **MUST** re-verify the confirmed state and record the order in one atomic step (STB-7). Checking first and writing later, without a lock or an equivalent database constraint, lets a price change land in between.

**Clock skew.** Expiry checks depend on clocks. Services **SHOULD** use a monotonic, NTP-disciplined clock and **MAY** allow a small skew (≤ 5 s).

**Client-supplied data.** The client supplies *identifiers* (scene object, SKU, variant, quantity) and the *hash it rendered*. It never supplies prices or totals (STB-4). A client that lies about the hash only causes its own request to fail.

**Agent prompt injection.** An agent can be manipulated by content it reads. AGT-1 ensures that even a fully compromised agent cannot place an order; the worst case is a draft cart the consumer still has to confirm.

**Privacy.** Snapshots contain product identifiers, not personal data. Grants and orders contain participant identifiers; deployments **SHOULD** use pseudonymous identifiers in logs and **MUST** follow applicable privacy law, including laws specific to children's data.

**Denial of service.** Idempotency and nonce stores grow with traffic. Records **SHOULD** expire after their retention window, and request bodies **SHOULD** be size-limited (the reference server accepts at most 64 KiB).

**Reference server scope.** In its default mode the reference server keeps state in memory and signs with a per-process key. With `OICT_DATABASE_URL` and a shared `OICT_SIGNING_KEY` it runs as many instances on PostgreSQL. It acts as its own authorization server for convenience, and does not authenticate consumers themselves, which is the platform's job. It remains a correctness reference and a conformance target, **not** a production service.
