# 04 · Minor Protection Profile

Immersive platforms have very young audiences. When physical goods and real payments enter those environments, the transaction layer — not each UI separately — is the right place to enforce a consistent floor of protection.

## Age bands

| `ageBand` | Meaning |
|---|---|
| `under13` | Consumer is younger than 13. |
| `13-17` | Consumer is a teen. |
| `adult` | Consumer is 18 or older. |

OICT does **not** perform age verification. The age band is asserted by the platform's or merchant's own age-assurance process when the consumer is registered.

**MIN-4.** A service **SHOULD** record which process asserted the age band and **SHOULD** re-evaluate it when the platform reports a change.

## Rules

**MIN-1.** A consumer in the `under13` band **MUST NOT** be able to issue grants containing `cart:write` or `order:place`, and **MUST NOT** be able to confirm a purchase. Failure code: `MINOR_RESTRICTED`.

**MIN-2.** For a consumer in the `13-17` band, a confirmation whose total exceeds the service's *teen unassisted limit* **MUST** carry a `guardianConsentRef`; otherwise it fails with `GUARDIAN_CONSENT_REQUIRED`. The limit is a merchant policy setting (reference default: 5,000 minor units).

**MIN-3.** A teen purchase at or below the limit **MAY** proceed with an ordinary confirmation, subject to every other rule in this specification.

See also **AGT-5**: an agent acting for a teen always requires guardian consent.

## Guardian consent references

A `guardianConsentRef` is an opaque identifier pointing to a consent record held by the platform or merchant (for example, a parental-approval flow completed in a family account). OICT only requires that it be present, that it travel with the confirmation and the order, and that it be auditable. Implementations **SHOULD** verify the reference against the issuing system before accepting it.

## Design notes

* Consent is **affirmative** and **specific**: it rides on a confirmation bound to one snapshot, not on a standing "allow purchases" toggle.
* Every refusal returns a stable code, so applications can show an age-appropriate explanation instead of a generic error.
