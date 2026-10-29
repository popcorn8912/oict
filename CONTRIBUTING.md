# Contributing to OICT

Thank you for helping make immersive and agentic commerce safer. There are three good ways to contribute.

| You want to… | Do this |
|---|---|
| **Try OICT against your own integration** | Run the conformance suite, then file a [trial report](../../issues/new?template=trial-report.yml). Trial reports directly shape the roadmap. |
| **Change the specification** | Open a [spec proposal](../../issues/new?template=spec-proposal.yml) describing the failure mode, evidence, and proposed rule text. |
| **Fix or add code / tests** | Open a pull request (see below). |

## Development

```bash
git clone https://github.com/popcorn8912/oict && cd oict
npm test              # unit + conformance tests (Node ≥ 22.18, no install needed)
npm run conformance   # pretty conformance report against the reference server
npm run bench         # anomaly-injection benchmark
npm run dev           # reference server with test hooks, auto-reload
```

The runtime has **zero dependencies**. Node's built-in type stripping runs the TypeScript sources directly; `npm install && npm run typecheck` is only needed for type checking.

## Pull requests

1. Every behavioural change needs a test. A new normative rule needs a conformance case whose `rule` field cites it.
2. Keep rule identifiers stable. Never renumber an existing rule; deprecate it instead.
3. Use synthetic data only. Never include real product data, real customer data, or anything confidential.
4. Sign off every commit (DCO, below).

## Developer Certificate of Origin

All commits must be signed off (`git commit -s`), certifying the [Developer Certificate of Origin 1.1](https://developercertificate.org/): that you wrote the contribution or otherwise have the right to submit it under the project's license. See also [PROVENANCE.md](PROVENANCE.md).

## Conduct

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
