import assert from "node:assert/strict";
import test from "node:test";
import { resolveAIProtocolOrder } from "../../src/lib/aiProtocol";

test("structured JSON tasks prefer Responses with Chat fallback", () => {
  assert.deepEqual(
    resolveAIProtocolOrder({ responseFormat: "json_object" }),
    ["responses", "chat_completions"],
  );
});

test("ordinary plain text tasks prefer Chat with Responses fallback", () => {
  assert.deepEqual(
    resolveAIProtocolOrder({}),
    ["chat_completions", "responses"],
  );
});

test("continuable long-form tasks keep the stable Chat-first delivery path", () => {
  assert.deepEqual(
    resolveAIProtocolOrder({ continueOnOutputLimit: true }),
    ["chat_completions", "responses"],
  );
});

test("an explicit protocol preference overrides automatic routing", () => {
  assert.deepEqual(
    resolveAIProtocolOrder({
      preference: "chat_completions",
      responseFormat: "json_object",
      continueOnOutputLimit: true,
    }),
    ["chat_completions", "responses"],
  );
});
