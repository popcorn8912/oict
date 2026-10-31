# Security Policy

## Reporting a vulnerability

If you find a weakness in the OICT **specification** (a rule that can be bypassed) or in the **reference implementation**, please report it privately using GitHub's [private vulnerability reporting](../../security/advisories/new). Do not open a public issue.

Please include the rule identifier(s) involved, a minimal reproduction (ideally as a failing conformance case), and the impact you expect.

You can expect an acknowledgement within 7 days and a status update within 30 days. Accepted spec issues are fixed with a new rule or conformance case and credited in the [CHANGELOG](CHANGELOG.md) unless you prefer otherwise.

## Scope

The reference server is a correctness reference, not a production service (see [spec/07](spec/07-security-considerations.md)). Reports that the reference server acts as its own authorization server, or about the in-memory default mode, are expected behaviour; reports that it violates a normative rule are very welcome.
