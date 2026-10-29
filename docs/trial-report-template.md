# OICT Trial Report — Template

Use this template (or the [issue form](../../../issues/new?template=trial-report.yml)) to record an independent evaluation. A trial report is most useful when it is specific, reproducible and honest about what did not work.

---

**Organization / team:**
**Relationship to the OICT maintainer:** none · former colleague · other (describe)
**Date(s) of trial:**
**OICT version / commit:**
**Evaluator name & role:**

## 1. Context
- What do you build? (platform, engine, interaction mode, audience)
- Which commerce protocol or API does your checkout use?

## 2. What you ran
- [ ] `npm run demo`
- [ ] `npm run conformance` against the reference server
- [ ] `oict-conformance --target <your service>`
- [ ] Integrated OICT rules into your own service (describe scope)

## 3. Results
- Conformance summary (`passed/total`), with the JSON report attached
- Failure modes OICT caught that you had not handled
- Rules that did not fit your case, and why
- False positives (legitimate purchases blocked)

## 4. Effort
- Time to first successful run:
- Estimated integration effort with OICT vs. without (hours, and how you estimated):

## 5. Would you continue using it? What would make it more useful?

## 6. Permission
- [ ] OICT may list our organization in ADOPTERS.md
- [ ] OICT may quote this report publicly

Signature / contact (optional):
