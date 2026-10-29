# Changelog

All notable changes to the OICT specification and reference implementation. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

## [0.1.0] — 2026-10-29

### Added
- Specification draft v0.1: participants & delegation (`MPA`, `DLG`, `REV`), state–order binding (`STB`), AI agent controls (`AGT`), minor protection (`MIN`), idempotency & errors (`IDM`, `ERR`), non-normative protocol profiles, security considerations.
- JSON Schemas for participants, grants, interaction snapshots, confirmation claims, orders and errors.
- Zero-dependency reference engine and HTTP server with fixture hooks.
- Conformance suite: 39 cases, CLI runner with JSON report output.
- Anomaly-injection benchmark comparing OICT with a naive checkout-only baseline.
- Interactive browser demo and project site.
