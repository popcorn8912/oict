# Quickstart

Goal: from `git clone` to a passing conformance run in under five minutes. Requires **Node.js ≥ 22.18** (no `npm install` needed) or Docker.

## 1. Run the walkthrough

```bash
git clone https://github.com/popcorn8912/oict && cd oict
npm run demo
```

You will see a shopper, an AI helper, a price change and a retry storm — and exactly one order at the end.

## 2. Run the reference server

```bash
npm run dev            # http://localhost:8787 with /v1/_test hooks enabled
```

or with Docker:

```bash
docker compose up      # starts the server, then runs the conformance suite against it
```

## 3. Make a purchase by hand

```bash
H='content-type: application/json'
curl -s -XPOST localhost:8787/v1/participants -H "$H" -d '{"id":"plat","kind":"platform"}'
curl -s -XPOST localhost:8787/v1/participants -H "$H" -d '{"id":"dev","kind":"developer"}'
curl -s -XPOST localhost:8787/v1/participants -H "$H" -d '{"id":"app","kind":"application","platformId":"plat","developerId":"dev"}'
curl -s -XPOST localhost:8787/v1/participants -H "$H" -d '{"id":"maya","kind":"consumer","ageBand":"adult"}'

GRANT=$(curl -s -XPOST localhost:8787/v1/grants -H "$H" \
  -d '{"issuer":"maya","subject":"app","application":"app","scopes":["order:place"],"ttlSeconds":3600}' | jq -r .id)
SES=$(curl -s -XPOST localhost:8787/v1/sessions -H "$H" -d '{"consumerId":"maya","applicationId":"app"}' | jq -r .id)
HASH=$(curl -s -XPOST localhost:8787/v1/sessions/$SES/selection -H "$H" \
  -d '{"sceneObjectId":"rack","sku":"SYN-HOODIE-01","variantId":"violet-m","quantity":1}' | jq -r .snapshotHash)
TOKEN=$(curl -s -XPOST localhost:8787/v1/confirmations -H "$H" \
  -d "{\"sessionId\":\"$SES\",\"consumerId\":\"maya\",\"snapshotHash\":\"$HASH\"}" | jq -r .confirmationToken)

curl -s -XPOST localhost:8787/v1/orders -H "$H" -H "authorization: OICT-Grant $GRANT" \
  -H "idempotency-key: my-first-order-1" -d "{\"sessionId\":\"$SES\",\"confirmationToken\":\"$TOKEN\"}" | jq
```

## 4. Test your own service

Implement the endpoints in the [API reference](api.md) plus the three fixture hooks, then:

```bash
node conformance/cli.ts --target https://your-staging-host --json report.json
```

Attach `report.json` to a [trial report](../../../issues/new?template=trial-report.yml).
