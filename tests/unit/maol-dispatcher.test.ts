import assert from "node:assert/strict";
import test from "node:test";
import { classifyAgentFailure } from "../../src/lib/maol/dispatcher";

test("agent failures expose stable categories without provider payloads", () => {
  assert.equal(
    classifyAgentFailure(new Error("deepseek-v4-flash made no visible progress before reaching the output limit")),
    "provider_output_limit",
  );
  assert.equal(
    classifyAgentFailure(new Error("Responses API request failed: 503 upstream unavailable")),
    "provider_unavailable",
  );
  assert.equal(
    classifyAgentFailure(new Error("AUTHOR harness stage section-2 omitted heading")),
    "harness_validation",
  );
});
