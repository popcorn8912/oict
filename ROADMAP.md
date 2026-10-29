# Roadmap

| Phase | Window | Deliverables | Done when |
|---|---|---|---|
| **1 · Spec & reference** | Months 1–6 | Spec v1.0 · reference service · two sample clients (3D object selection, AI assistant) · conformance suite v1 | Public release · ≥ 50 conformance cases · a new developer runs the samples within one day |
| **2 · Cross-application validation** | Months 7–12 | Third interaction mode (voice or AR panel) · agent-control module wired to open checkout protocols · comparative experiment report | Integration effort for a new application reduced by ≥ 40 % · anomaly detection ≥ 95 % |
| **3 · Independent evaluation** | Year 2 | Trial reports from ≥ 3 external teams · peer-reviewed paper · ≥ 2 talks | Written trial records · paper accepted |
| **4 · Adoption & standardization** | Year 3 | Spec v2.0 · extension proposal to open-protocol communities · maintainer community | ≥ 5 independent organizations trialled or integrated · ≥ 1 proposal submitted |

## Now — v0.1 (this release)

- [x] Spec draft: participants, delegation, revocation, state binding, agent controls, minor protection, idempotency, errors
- [x] Zero-dependency reference engine and HTTP server
- [x] 39 conformance cases across 8 categories, with a CLI runner and JSON reports
- [x] Reproducible anomaly-injection benchmark
- [x] Interactive browser demo of state binding

## Next — v0.2

- [ ] Conformance suite to ≥ 50 cases (multi-item carts, quantity changes, partial revocation)
- [ ] Multi-item cart snapshots
- [ ] JWS (asymmetric) confirmation tokens
- [ ] Containerized sample clients: three.js scene and chat-assistant client
- [ ] Integration-effort study protocol (how the 40 % metric is measured)

## Later

- [ ] Game-engine (C#) sample client
- [ ] Voice and AR-panel interaction profiles
- [ ] Versioned adapter profiles for open checkout protocols
- [ ] Persistent storage backends for the reference server
