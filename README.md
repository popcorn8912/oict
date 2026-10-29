<p align="center">
  <a href="https://popcorn8912.github.io/oict/"><img src="assets/banner.svg" alt="OICT — Open Immersive Commerce Transaction Framework. What the shopper saw is what gets ordered." width="100%"></a>
</p>

<p align="center">
  <a href="https://github.com/popcorn8912/oict/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/popcorn8912/oict/ci.yml?branch=main&style=flat-square&label=ci&labelColor=1F1A48&color=7CF2B0"></a>
  <img alt="Conformance 39/39" src="https://img.shields.io/badge/conformance-39%2F39-7CF2B0?style=flat-square&labelColor=1F1A48">
  <img alt="Anomaly detection 100% in benchmark" src="https://img.shields.io/badge/anomaly%20detection-100%25%20(sim)-B490FF?style=flat-square&labelColor=1F1A48">
  <img alt="Zero runtime dependencies" src="https://img.shields.io/badge/runtime%20deps-0-5EE7DF?style=flat-square&labelColor=1F1A48">
  <img alt="Node 22.18+" src="https://img.shields.io/badge/node-%E2%89%A522.18-5EE7DF?style=flat-square&labelColor=1F1A48">
  <a href="LICENSE"><img alt="Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-FF8BD1?style=flat-square&labelColor=1F1A48"></a>
</p>

<p align="center">
  <b><a href="https://popcorn8912.github.io/oict/#playground">Live playground</a></b> ·
  <a href="spec/README.md">Specification</a> ·
  <a href="docs/quickstart.md">Quickstart</a> ·
  <a href="conformance/cases.ts">Conformance cases</a> ·
  <a href="ROADMAP.md">Roadmap</a>
</p>

---

Real-world products are now bought **inside games, 3D worlds, AR/VR scenes and conversations with AI agents**. Open commerce protocols already handle catalogs, checkout and payment. What they leave to each team is the hard part in between:

- **Who is buying for whom?** A single purchase can involve a platform, a developer, an app, a merchant, a consumer and an AI agent acting for that consumer.
- **Is this what they saw?** The shopper switched from violet to teal, the price changed, the network timed out and the client retried. Which order did the person actually mean?
- **Can anyone prove it?** There is no shared, runnable test for revoked authority, duplicate submissions, stale confirmations or purchases by minors.

**OICT** (Open Immersive Commerce Transaction Framework) is an open **transaction-integrity layer** that answers those questions. It sits on top of the checkout you already use and ships as a specification, a zero-dependency reference implementation, and a conformance suite any team can run against its own service.

<p align="center">
  <img src="assets/flow.svg" alt="Purchase requests from a 3D world, an AR/VR scene and an AI agent pass through the OICT layer before the checkout. Valid requests pass; a stale confirmation and an agent overreach are stopped." width="100%">
</p>

## See it in 30 seconds

```bash
git clone https://github.com/popcorn8912/oict && cd oict
npm run demo        # Node.js ≥ 22.18 — nothing to install
```

```text
  3. Maya picks up a hoodie in the 3D scene
     ✔ stateVersion 1  violet-m  $42.00  sha256:6c7dddb1407c8ed…
     ✔ switches to teal-m → stateVersion 2  $39.00

  4. The AI helper, a beat behind, drafts a cart for the old variant
     ⛔ draft against stateVersion 1 → STALE_STATE

  5. Maya taps Buy — then the price changes before the order lands
     ⛔ order → STALE_CONFIRMATION — Maya never agreed to $45

  7. The headset's Wi-Fi drops; the client retries — twice
     ✔ same key → same order ord_J-NMyBdXbT40 (replay: true)
     ⛔ regenerated key → CONFIRMATION_CONSUMED — one tap, one order

  ✔ 1 intended order. 0 unintended orders.
```

Or skip the terminal and **[try to break it in your browser](https://popcorn8912.github.io/oict/#playground)**.

## Four rules, enforced where the order is created

| | Rule | What it means | Spec |
|:-:|---|---|---|
| 🔷 | **Who may act, for whom** | Authority starts with the consumer, flows through an explicit platform → developer → application chain, only narrows when delegated, and is revoked everywhere at once. | [`MPA` `DLG` `REV`](spec/01-participants.md) |
| 🪞 | **Saw it = ordered it** | Every scene change bumps a state version. A confirmation is bound to the hash of exactly what was on screen, expires in two minutes, and is checked again at placement. | [`STB`](spec/02-state-binding.md) |
| 🤖 | **Agents prepare, people decide** | An AI agent can draft a cart for the state it actually saw. It can never hold `order:place` — not even with a valid confirmation in hand. | [`AGT`](spec/03-agent-controls.md) |
| 🛡️ | **Minors protected by default** | Under-13 accounts cannot authorize physical purchases. Teen orders above a merchant limit, and any agent acting for a teen, need guardian consent. | [`MIN`](spec/04-minor-protection.md) |

Duplicate purchases are stopped twice: by idempotency keys **and** by single-use confirmations, so a client that regenerates its request ID after a timeout still cannot buy twice ([`IDM`](spec/05-idempotency-and-errors.md)).

## Proof you can run

<p align="center">
  <img src="assets/conformance.svg" alt="Terminal: 39 of 39 OICT conformance cases pass across eight categories." width="80%">
</p>

The conformance suite talks to **any** implementation over HTTP. Every case cites the rule it verifies, so a failure points straight at a sentence in the spec.

```bash
npm run conformance                                   # against the reference server
node conformance/cli.ts --target https://your-host --json report.json   # against yours
```

<p align="center">
  <img src="assets/benchmark.svg" alt="Benchmark: OICT blocks every injected anomaly type across 5,000 synthetic flows with no false positives; a naive checkout-only baseline blocks only revoked authority." width="90%">
</p>

`npm run bench` replays 5,000 seeded, synthetic purchase flows with nine kinds of injected anomaly against OICT and against a naive checkout-only integration. Full numbers: [`benchmarks/results/latest.md`](benchmarks/results/latest.md). These are simulator results that show the rules work as specified; they are not production measurements.

## How a purchase flows

```mermaid
sequenceDiagram
    autonumber
    participant U as Shopper
    participant A as App (3D · AR · chat)
    participant G as AI agent
    participant M as Merchant service + OICT
    U->>A: picks the teal hoodie
    A->>M: selection → stateVersion 2, snapshot hash h2
    G->>M: draft cart @ stateVersion 2 (cart:write only)
    M-->>A: draft bound to h2
    U->>A: taps Buy on what is shown
    A->>M: confirm h2
    M-->>A: confirmation token (h2, 120 s, single use)
    A->>M: place order + Idempotency-Key
    M->>M: re-check h2 · grant chain · minor policy
    M-->>A: 201 order (records snapshot h2)
```

## What's in the box

```text
spec/            Normative specification (RFC 2119), every rule with a stable ID
schemas/         JSON Schemas: participant, grant, snapshot, confirmation, order, error
src/core/        Reference engine — grants, delegation, snapshots, confirmations, idempotency
src/server/      Zero-dependency HTTP reference server (+ fixture hooks for testing)
conformance/     39 executable cases + CLI runner with JSON reports
benchmarks/      Seeded anomaly-injection benchmark vs. a naive baseline
examples/        Narrated end-to-end walkthrough
site/            The live playground (GitHub Pages)
docs/            Quickstart, API reference, trial-report template
```

| Command | What it does |
|---|---|
| `npm run demo` | Narrated walkthrough with an AI helper, a price change and a retry storm |
| `npm test` | Unit tests + full conformance suite (54 tests) |
| `npm run conformance` | Pretty conformance report (`-- --compact` for one line per category) |
| `npm run bench` | Anomaly-injection benchmark; writes `benchmarks/results/` |
| `npm run dev` | Reference server on `:8787` with test hooks, auto-reload |
| `docker compose up` | Server + conformance run in containers |

## Where OICT fits

OICT does **not** replace catalogs, checkout or payment. It is designed as a profile on top of open commerce protocols (such as the Universal Commerce Protocol and the Agentic Commerce Protocol), platform commerce APIs, and OAuth 2.0 identity. See [protocol profiles](spec/06-protocol-profiles.md) for the concept mapping.

## Roadmap

- **v0.1 (now):** spec draft, reference engine, 39 conformance cases, benchmark, playground
- **v0.2:** ≥ 50 cases, multi-item carts, JWS confirmations, containerized three.js and chat clients
- **Next:** game-engine (C#) sample, voice and AR-panel profiles, adapter profiles, extension proposals to open-protocol communities

Details and success criteria: [ROADMAP.md](ROADMAP.md).

## Get involved

- **Run OICT against your integration** and file a [trial report](../../issues/new?template=trial-report.yml). Independent trials are the most valuable contribution right now. Adopters are listed in [ADOPTERS.md](ADOPTERS.md).
- **Propose a rule** with a [spec proposal](../../issues/new?template=spec-proposal.yml).
- **Send code**: see [CONTRIBUTING.md](CONTRIBUTING.md). All commits are signed off under the DCO.

## Provenance

OICT is an independent open-source project built from public specifications with synthetic data only. It is not affiliated with or endorsed by any employer, retailer, platform or protocol owner. See [PROVENANCE.md](PROVENANCE.md).

## Citation

If you use OICT in research or an evaluation, please cite it via [CITATION.cff](CITATION.cff) (GitHub's "Cite this repository" button).

## License

[Apache-2.0](LICENSE) © 2026 Cirun Zhang and OICT contributors.
