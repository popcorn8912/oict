import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { CASES } from "../conformance/cases.ts";
import { Client } from "../conformance/client.ts";
import { createServer } from "../src/server/http.ts";

describe("reference server passes the full conformance suite", () => {
  const server = createServer({ testHooks: true });
  let client: Client;

  before(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    client = new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  });
  after(() => server.close());

  it("has at least 35 uniquely numbered cases", () => {
    assert.ok(CASES.length >= 35);
    assert.equal(new Set(CASES.map((c) => c.id)).size, CASES.length);
  });

  for (const c of CASES) {
    it(`${c.id} ${c.title}`, async () => {
      await c.run(client);
    });
  }
});
