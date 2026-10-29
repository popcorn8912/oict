# 06 · Protocol Profiles (Non-normative)

OICT is designed to sit **on top of** an existing commerce protocol. This document sketches how its concepts map onto common building blocks. It is **non-normative** and **illustrative**: field names in external protocols change, so always check the current version of the protocol you integrate with.

## Layering

```
┌──────────────────────────────────────────────────────────────┐
│  Immersive / agent interface  (3D scene · AR · VR · chat)    │
├──────────────────────────────────────────────────────────────┤
│  OICT  ── participants · grants · snapshots · confirmations  │  ← this project
├──────────────────────────────────────────────────────────────┤
│  Commerce protocol  (UCP · ACP · platform commerce APIs)     │
├──────────────────────────────────────────────────────────────┤
│  Identity & payment rails  (OAuth 2.0 · tokenized payments)  │
└──────────────────────────────────────────────────────────────┘
```

## Concept mapping

| OICT concept | Typical counterpart in the layer below | What OICT adds |
|---|---|---|
| Consumer → application **grant** | An OAuth 2.0 authorization / account-linking result | Application-level confinement, explicit multi-party chain, inheritance rules, cascade revocation |
| **Delegated** agent grant | A scoped token or delegated credential for an agent | A hard rule that the agent's grant never includes `order:place` |
| **Interaction snapshot** | A checkout session or cart object | `sceneObjectId`, `stateVersion`, `variantVersion`, `priceVersion` and a canonical hash |
| **Confirmation token** | A user-consent artifact or payment authorization | Binding of consent to one snapshot hash, short expiry, single use |
| **Idempotency-Key** | Idempotency on the checkout/order call | A second, key-independent guard (IDM-4) |
| **Error codes** | Protocol-specific errors | A stable vocabulary for integrity failures that UIs can explain |

## Integration pattern

1. Keep your existing checkout call. Before calling it, require a valid OICT confirmation token and run the STB-7 re-check.
2. Store the OICT snapshot and hash alongside the order the underlying protocol returns.
3. Map OICT error codes to your protocol's error channel; keep the OICT code in a machine-readable field.
4. Run `oict-conformance --target <your-service>` in CI.

Planned work (see [ROADMAP](../ROADMAP.md)) includes concrete, versioned adapter profiles and an evidence-based extension proposal to the relevant open-protocol communities.
