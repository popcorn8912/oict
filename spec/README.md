# OICT Specification · v0.2 (Draft)

> **Status:** Working draft. Breaking changes are expected before v1.0.
> Feedback is welcome through [GitHub Discussions](../../../discussions) or a [spec proposal issue](../../../issues/new?template=spec-proposal.yml).

The Open Immersive Commerce Transaction Framework (OICT) is a **transaction-integrity layer**. It does not define catalogs, checkout or payment; those belong to the underlying commerce protocol. OICT adds the rules that keep a real-world purchase honest when it starts inside a game, a 3D world, an AR/VR scene or a conversation with an AI agent:

1. **Who is acting for whom, with what authority** — across platform, developer, application, merchant, consumer and agent.
2. **What the consumer saw is what gets ordered** — even when the scene, variant or price changes while the request is in flight.
3. **Agents prepare, people decide** — an AI agent can build a cart, but only a fresh, specific consumer confirmation can turn it into an order.
4. **Minors are protected by default** — age-band rules are enforced by the transaction layer, not left to each UI.

## Documents

| # | Document | Rules |
|---|---|---|
| 01 | [Participants, grants, delegation & authentication](01-participants.md) | `MPA-*`, `DLG-*`, `REV-*` |
| 02 | [State–order binding](02-state-binding.md) | `STB-*` |
| 03 | [AI agent controls](03-agent-controls.md) | `AGT-*` |
| 04 | [Minor protection profile](04-minor-protection.md) | `MIN-*` |
| 05 | [Idempotency & errors](05-idempotency-and-errors.md) | `IDM-*`, `ERR-*` |
| 06 | [Protocol profiles (non-normative)](06-protocol-profiles.md) | — |
| 07 | [Security considerations](07-security-considerations.md) | — |

## Conventions

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **MAY** and **OPTIONAL** are to be interpreted as described in RFC 2119 and RFC 8174 when, and only when, they appear in all capitals.

Every normative rule has a stable identifier (for example `STB-7`). Conformance cases in [`/conformance`](../conformance) cite the rules they verify, so an implementer can trace any failing test back to a sentence in this specification.

## Roles

| Role | Description |
|---|---|
| **Platform** | Operates the immersive environment (a game engine runtime, a virtual-world platform, an AR/VR store). |
| **Developer** | Publishes content on the platform. |
| **Application** | A specific experience (a game, a world, an AR lens) published by a developer on a platform. |
| **Merchant** | Sells real-world goods; runs the OICT-conformant transaction service. |
| **Consumer** | The person buying. The only root of purchase authority. |
| **Agent** | Software (typically an AI assistant) that acts for a consumer within limits the consumer set. |

## Conformance levels

| Level | Requirement |
|---|---|
| **Core** | Passes every case in the conformance suite for categories `AUTH`, `DLG`, `REV`, `IDM`, `STB`, `ERR`. |
| **Agentic** | Core + all `AGT` cases. |
| **Youth-safe** | Core + all `MIN` cases. |

The reference server in this repository targets **Core + Agentic + Youth-safe**.
