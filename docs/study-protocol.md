# Evaluation Protocol

This protocol defines how OICT's three headline targets are measured, so that anyone can repeat the measurement and check the result. It describes **how** results will be obtained. It does not report results; those are published separately as dated study reports in `docs/studies/`, each with its raw data.

| Target | Metric | Section |
|---|---|---|
| Integration effort for a new application reduced by **≥ 40 %** | Developer time to a conformant integration, OICT vs. baseline | [1](#1-integration-effort-study) |
| **≥ 95 %** of injected anomalies detected | Detection rate on a held-out anomaly set | [2](#2-anomaly-detection-study) |
| A new developer runs the samples **within one day** | Time from clone to first passing conformance run | [3](#3-onboarding-measure) |

## 1. Integration-effort study

### Question

Does starting from OICT (specification, reference service, client, conformance suite) reduce the effort needed to add a transaction-integrity layer to an immersive or agentic checkout, compared with building it on a plain checkout API?

### Task

Each participant receives the same small application: a 3D product scene or a chat assistant that can already call a plain checkout endpoint. They must make it meet a fixed requirement list:

1. Orders go through only with the consumer's fresh confirmation of the exact cart shown (price, variant, quantity).
2. A client retry, with the same or a regenerated request id, never creates a second order.
3. An AI helper can prepare carts but cannot place orders.
4. A consumer can withdraw an application's purchase rights while keeping its read access.
5. Purchases by a 13–17-year-old above a set limit need guardian consent.

The list maps to OICT rules (STB-1…10, IDM-1…4, AGT-1…5, REV-5, MIN-2), but participants in the baseline condition receive only the plain-language list.

### Conditions

| | Baseline (A) | OICT (B) |
|---|---|---|
| Starting point | Plain checkout API and the requirement list | Same, plus the OICT spec, reference server, `oict-client.js` and the conformance suite |
| Done when | The **hidden acceptance suite** passes | The **hidden acceptance suite** passes |

The hidden acceptance suite is a fixed set of black-box HTTP and UI checks written from the requirement list. It is **not** the OICT conformance suite, so condition B gets no advantage from having seen the tests. It is versioned and frozen before the first session.

### Design

- **Participants:** at least 6 software developers with commerce, game or AR/VR experience, from at least 3 organisations, none of whom contributed to OICT. Record role, years of experience and familiarity with the domain. Record no other personal data.
- **Assignment:** a between-subjects design, randomised and balanced on years of experience. With enough participants, run a crossover instead, where each person does both conditions on two different applications (3D, chat) in counterbalanced order.
- **Time box:** 8 hours of working time per condition. A participant who does not finish is recorded as "8 h, not complete" and kept in the analysis.

### Measures

| Measure | How | Primary? |
|---|---|---|
| **Time to acceptance** | Working minutes from start until the hidden suite first passes, from a self-started timer and commit timestamps | **Yes** |
| Code changed | Lines added and modified in the participant's repository (excluding generated and vendored files) | No |
| Defects at hand-in | Hidden-suite checks still failing at the time box | No |
| Perceived effort | NASA-TLX raw score after the task | No |

**Effort reduction** = 1 − median(time, B) / median(time, A). The target is met when this is ≥ 0.40.

### Analysis and reporting

- Report every participant's numbers, the medians, the interquartile ranges and the effect size (Cliff's delta). With small samples, describe the results and do not claim significance.
- Report non-completions and how they were counted.
- Publish the hidden acceptance suite, the task repository and the anonymised data sheet with each report.

### Threats to validity

| Threat | Mitigation |
|---|---|
| The task favours OICT's design | Requirements are written in plain language first; the acceptance suite is written from them, not from the OICT spec |
| Participant skill differences | Balanced assignment; crossover design when possible; experience is reported |
| Learning effects (crossover) | Different applications per condition, counterbalanced order |
| Facilitator influence | Written instructions only; questions answered from a fixed FAQ |
| Self-reported time | Cross-checked against commit timestamps |

## 2. Anomaly-detection study

The repository benchmark (`npm run bench`) injects nine anomaly types that the OICT authors defined. Detecting anomalies we designed ourselves is weak evidence. The study therefore adds a **held-out set**.

1. Two or more reviewers who did not write OICT each write anomaly scenarios against the plain-language requirement list (section 1), for example "the price changes between the confirmation and the order on another instance", or "an agent re-uses an old confirmation". Each scenario is a script with an expected outcome: no order, exactly one order, or a refusal.
2. Every scenario runs against the OICT reference server (memory and PostgreSQL, one and three instances) and against the baseline integration from section 1.
3. **Detection rate** = scenarios whose final state matches the expected outcome ÷ all scenarios. Also report the false-positive rate on a matched set of legitimate flows. The target is ≥ 95 % detection with a false-positive rate reported next to it.
4. Every scenario OICT fails becomes a public issue and, when it reveals a gap, a new rule and conformance case.

## 3. Onboarding measure

Recruit developers who have never seen OICT. With only the README, measure the minutes from `git clone` to:

1. `npm run demo` completing,
2. `npm run conformance` passing,
3. one sample client placing an order against a local server (`docker compose up`).

The target is all three within one working day, for every participant. Record blockers verbatim; each one becomes a documentation issue.

## 4. Data sheet

One row per participant per condition. Store it as CSV next to the study report.

| Field | Example |
|---|---|
| `participant` | `P03` (pseudonymous) |
| `org_type` | `game studio` · `retailer` · `agency` · `independent` |
| `years_experience` | `7` |
| `condition` | `A` · `B` |
| `application` | `3d` · `chat` |
| `minutes_to_acceptance` | `212` |
| `completed` | `true` |
| `lines_changed` | `640` |
| `hidden_suite_failing_at_end` | `0` |
| `nasa_tlx_raw` | `41` |
| `notes` | free text, no personal data |

## 5. Ethics and consent

Participation is voluntary, and participants can withdraw at any time without giving a reason. Store only the data sheet fields above, with pseudonymous ids. Do not record screens or audio unless a participant opts in for that session. A participant's organisation is named in a report only with written permission, which is recorded as for an entry in [ADOPTERS.md](../ADOPTERS.md).
