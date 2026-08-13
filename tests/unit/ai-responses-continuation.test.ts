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

test("automatic long-form routing uses Chat while keeping contract-aware continuation", async () => {
  const originalFetch = globalThis.fetch;
  const endpoints: string[] = [];
  const prompts: string[] = [];

  globalThis.fetch = async (input, init) => {
    endpoints.push(String(input));
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages?: Array<{ content?: string }>;
    };
    prompts.push(body.messages?.at(-1)?.content ?? "");

    if (endpoints.length === 1) {
      return Response.json({
        choices: [{
          message: { content: "## 2.1 Population growth\n\nFirst half." },
          finish_reason: "length",
        }],
      });
    }
    return Response.json({
      choices: [{
        message: { content: "Second half." },
        finish_reason: "stop",
      }],
    });
  };

  try {
    const text = await generateText("STRICT_CHAPTER_CONTRACT", {
      agent: "AUTHOR",
      maxTokens: 1024,
      stream: false,
      continueOnOutputLimit: true,
      maxContinuationSegments: 3,
      continuationPrompt: ({ accumulatedText }) =>
        `STRICT_CHAPTER_CONTRACT\nPARTIAL=${accumulatedText}`,
      overrides: {
        version: 1,
        agents: {
          AUTHOR: {
            apiKey: "test-key",
            baseUrl: "https://chat-long-form.test/v1",
            model: "test-chat-model",
          },
        },
      },
    });

    assert.equal(
      text,
      "## 2.1 Population growth\n\nFirst half.\nSecond half.",
    );
    assert.deepEqual(endpoints, [
      "https://chat-long-form.test/v1/chat/completions",
      "https://chat-long-form.test/v1/chat/completions",
    ]);
    assert.equal(prompts[0], "STRICT_CHAPTER_CONTRACT");
    assert.match(prompts[1] ?? "", /STRICT_CHAPTER_CONTRACT/u);
    assert.match(prompts[1] ?? "", /First half/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Chat output limits stay in the Chat route instead of switching to Responses", async () => {
  const originalFetch = globalThis.fetch;
  const endpoints: string[] = [];

  globalThis.fetch = async (input) => {
    endpoints.push(String(input));
    return Response.json({
      choices: [{
        message: { content: "partial stage" },
        finish_reason: "length",
      }],
    });
  };

  try {
    await assert.rejects(
      () => generateText("STRICT_CHAPTER_CONTRACT", {
        agent: "AUTHOR",
        maxTokens: 1024,
        stream: false,
        continueOnOutputLimit: true,
        maxContinuationSegments: 1,
        overrides: {
          version: 1,
          agents: {
            AUTHOR: {
              apiKey: "test-key",
              baseUrl: "https://chat-output-limit.test/v1",
              model: "test-chat-model",
            },
          },
        },
      }),
      /still reached the output limit/u,
    );
    assert.deepEqual(endpoints, [
      "https://chat-output-limit.test/v1/chat/completions",
      "https://chat-output-limit.test/v1/chat/completions",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Responses with no visible progress are circuit-broken for later calls", async () => {
  const originalFetch = globalThis.fetch;
  const endpoints: string[] = [];

  globalThis.fetch = async (input) => {
    const endpoint = String(input);
    endpoints.push(endpoint);
    if (endpoint.endsWith("/responses")) {
      return Response.json({
        id: "resp_no_text",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [{ type: "reasoning", summary: [] }],
      });
    }
    return Response.json({
      choices: [{
        message: { content: "chat fallback" },
        finish_reason: "stop",
      }],
    });
  };

  const overrides = {
    version: 1 as const,
    agents: {
      AUTHOR: {
        apiKey: "test-key",
        baseUrl: "https://responses-circuit-breaker.test/v1",
        model: "test-responses-model",
      },
    },
  };

  try {
    assert.equal(
      await generateText("FIRST", {
        agent: "AUTHOR",
        protocol: "responses",
        continueOnOutputLimit: true,
        maxContinuationSegments: 2,
        stream: false,
        overrides,
      }),
      "chat fallback",
    );
    assert.equal(
      await generateText("SECOND", {
        agent: "AUTHOR",
        protocol: "responses",
        continueOnOutputLimit: true,
        maxContinuationSegments: 2,
        stream: false,
        overrides,
      }),
      "chat fallback",
    );
    assert.deepEqual(endpoints, [
      "https://responses-circuit-breaker.test/v1/responses",
      "https://responses-circuit-breaker.test/v1/chat/completions",
      "https://responses-circuit-breaker.test/v1/chat/completions",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
