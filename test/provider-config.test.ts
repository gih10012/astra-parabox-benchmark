import assert from "node:assert/strict";
import test from "node:test";
import { parseProviderConfig } from "../src/provider-config.js";

test("copies only an allowlisted custom provider and no unrelated config", () => {
  const result = parseProviderConfig(`
model_provider = "proxy-one"
preferred_auth_method = "apikey"

[model_providers.proxy-one]
name = "proxy"
base_url = "https://example.test"
wire_api = "responses"
requires_openai_auth = true
http_headers = { Authorization = "secret" }

[mcp_servers.unwanted]
command = "bad"
`);
  assert.deepEqual(result, {
    id: "proxy-one",
    assignments: [
      { key: "model_provider", tomlValue: '"proxy-one"' },
      { key: "model_providers.proxy-one.name", tomlValue: '"proxy"' },
      {
        key: "model_providers.proxy-one.base_url",
        tomlValue: '"https://example.test"',
      },
      { key: "model_providers.proxy-one.wire_api", tomlValue: '"responses"' },
      {
        key: "model_providers.proxy-one.requires_openai_auth",
        tomlValue: "true",
      },
    ],
  });
});

test("uses the built-in provider when no custom provider is selected", () => {
  assert.equal(parseProviderConfig('model = "gpt-6-astra"\n'), null);
  assert.equal(parseProviderConfig('model_provider = "openai"\n'), null);
});
