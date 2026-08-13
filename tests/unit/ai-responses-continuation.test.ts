import assert from "node:assert/strict";
import test from "node:test";
import { generateText } from "../../src/lib/ai";

test("Responses continuation preserves the original contract harness and joins partial output", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, unknown>> = [];

  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push(body);

    if (requests.length === 1) {
      return Response.json({
        id: "resp_partial",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [{
          type: "message",
          content: [{ type: "output_text", text: "# Chapter\n\nFirst section.\n" }],
        }],
      });
    }

    return Response.json({
      id: "resp_complete",
      status: "completed",
      output: [{
        type: "message",
        content: [{ type: "output_text", text: "Second section.\n\n# Exercises" }],
      }],
    });
  };

  try {
    const text = await generateText("COURSE_BIBLE\nCHAPTER_CONTRACT\nSECTION_OUTLINE", {
      agent: "AUTHOR",
      maxTokens: 1024,
      stream: false,
      protocol: "responses",
      continueOnOutputLimit: true,
      maxContinuationSegments: 3,
      overrides: {
        version: 1,
        agents: {
          AUTHOR: {
            apiKey: "test-key",
            baseUrl: "https://responses-continuation.test/v1",
            model: "test-responses-model",
          },
        },
      },
    });

    assert.equal(
      text,
      "# Chapter\n\nFirst section.\nSecond section.\n\n# Exercises",
    );
    assert.equal(requests.length, 2);
    assert.equal(
      requests[0]?.input,
      "COURSE_BIBLE\nCHAPTER_CONTRACT\nSECTION_OUTLINE",
    );
    assert.equal(requests[1]?.previous_response_id, "resp_partial");
    assert.match(String(requests[1]?.input), /Continue the previous answer/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a provider without Responses falls back to Chat Completions", async () => {
  const originalFetch = globalThis.fetch;
  const endpoints: string[] = [];

  globalThis.fetch = async (input) => {
    const endpoint = String(input);
    endpoints.push(endpoint);
    if (endpoint.endsWith("/responses")) {
      return new Response("unknown endpoint", { status: 404 });
    }
    return Response.json({
      choices: [{
        message: { content: "fallback chapter" },
        finish_reason: "stop",
      }],
    });
  };

  try {
    const text = await generateText("CHAPTER_CONTRACT", {
      agent: "AUTHOR",
      stream: false,
      protocol: "responses",
      continueOnOutputLimit: true,
      overrides: {
        version: 1,
        agents: {
          AUTHOR: {
            apiKey: "test-key",
            baseUrl: "https://chat-fallback.test/v1",
            model: "test-chat-model",
          },
        },
      },
    });

    assert.equal(text, "fallback chapter");
    assert.deepEqual(endpoints, [
      "https://chat-fallback.test/v1/responses",
      "https://chat-fallback.test/v1/chat/completions",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
