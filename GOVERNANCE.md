# Governance

## Roles

- **Maintainer** — sets direction, merges changes, cuts releases. Founding maintainer: Cirun Zhang.
- **Reviewer** — contributors with a record of quality reviews, invited by maintainers. Reviewers can approve PRs in the areas they know.
- **Contributor** — anyone who opens an issue, a trial report, a discussion or a pull request.

The goal is a multi-organization maintainer group. A contributor from an organization not yet represented, with sustained contributions over three months, may be nominated as maintainer by any maintainer and confirmed by lazy consensus (no objection within 7 days).

## Decisions

- **Code and tests:** one maintainer or reviewer approval.
- **Normative spec changes** (new or changed `MUST`/`SHOULD` rules): an open spec proposal, at least 7 days for comment, and approval from a maintainer. Each change ships with conformance cases.
- **Breaking changes** after v1.0 require a deprecation period of at least one minor release.

## Versioning

The specification and the reference implementation share a version number and follow [Semantic Versioning](https://semver.org/). Every release is tagged, summarized in the [CHANGELOG](CHANGELOG.md) and archived for citation.

## Neutrality

OICT is vendor-neutral. No single company controls the specification, and rules must be implementable on any platform and on top of any commerce protocol.
