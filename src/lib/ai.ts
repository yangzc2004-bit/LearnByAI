import "server-only";

import { chatCompletionsUrl, responsesUrl } from "./aiEndpoint";
import {
  AIProtocol,
  AIProtocolPreference,
  resolveAIProtocolOrder,
} from "./aiProtocol";
import { getAgentConfig, getBaseAIConfig } from "./config";
import { extractJsonObjectText, repairInvalidJsonEscapes } from "./jsonRepair";
import { ModelOverrides } from "./modelOverrides";
import { safeErrorMessage } from "./safeError";
import { AgentName } from "./types";

export const MODEL = getBaseAIConfig().model;
type ProviderProtocol = AIProtocol;
type ChatTokenParameter = "max_tokens" | "max_completion_tokens";
const unsupportedResponsesCache = new Set<string>();
const unsupportedChatCompletionsCache = new Set<string>();
const chatTokenParameterCache = new Map<string, ChatTokenParameter>();
const responsesOmittedParametersCache = new Map<string, Set<"temperature" | "thinking">>();

type GenerateTextOptions = {
  agent?: AgentName;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  stream?: boolean;
  responseFormat?: "json_object";
  protocol?: AIProtocolPreference;
  continueOnOutputLimit?: boolean;
  maxContinuationSegments?: number;
  overrides?: ModelOverrides;
  onChunk?: (chunk: string) => void;
};

export function hasAI() {
  return Boolean(getBaseAIConfig().apiKey);
}

export async function generateText(
  prompt: string,
  options?: GenerateTextOptions,
): Promise<string> {
  if (process.env.AI_MOCK_MODE === "true") {
    throw new Error("AI_MOCK_MODE enabled; provider calls are disabled");
  }

  const overrides = options?.overrides;
  const config = options?.agent ? getAgentConfig(options.agent, overrides) : getBaseAIConfig(overrides);
  if (!config.apiKey) throw new Error("模型 API Key 未配置，请先在「模型设置」中填写并保存。");

  const protocolKey = `${config.baseUrl}\n${config.model}`;
  const protocols = resolveAIProtocolOrder({
    preference: options?.protocol,
    responseFormat: options?.responseFormat,
    continueOnOutputLimit: options?.continueOnOutputLimit,
  });
  let lastError: unknown;

  for (const protocol of protocols) {
    if (protocol === "responses" && unsupportedResponsesCache.has(protocolKey)) continue;
    if (protocol === "chat_completions" && unsupportedChatCompletionsCache.has(protocolKey)) continue;

    try {
      return await generateTextWithContinuation(protocol, prompt, options, config);
    } catch (error) {
      lastError = error;
      if (error instanceof ResponsesUnsupportedError) {
        unsupportedResponsesCache.add(protocolKey);
        logProtocolFallback(config, "responses", "chat_completions", error);
        continue;
      }
      if (error instanceof ChatCompletionsUnsupportedError) {
        unsupportedChatCompletionsCache.add(protocolKey);
        logProtocolFallback(config, "chat_completions", "responses", error);
        continue;
      }
      if (error instanceof ResponsesContinuationUnsupportedError) {
        logProtocolFallback(config, "responses", "chat_completions", error);
        continue;
      }
      if (error instanceof OutputLimitError && options?.continueOnOutputLimit) {
        logProtocolFallback(config, protocol, alternateProtocol(protocol), error);
        continue;
      }
      throw error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`${config.model} has no compatible text generation endpoint`);
}

async function generateTextWithContinuation(
  protocol: ProviderProtocol,
  prompt: string,
  options: GenerateTextOptions | undefined,
  config: AIConfig,
) {
  const maxSegments = options?.continueOnOutputLimit
    ? normalizeContinuationSegments(options.maxContinuationSegments)
    : 1;
  let accumulated = "";
  let currentPrompt = prompt;
  let previousResponseId: string | undefined;

  for (let segment = 0; segment < maxSegments; segment += 1) {
    try {
      const text = protocol === "responses"
        ? await generateResponsesText(currentPrompt, options, config, previousResponseId)
        : await generateChatCompletionsText(currentPrompt, options, config);
      return appendContinuation(accumulated, text);
    } catch (error) {
      if (!(error instanceof OutputLimitError) || !options?.continueOnOutputLimit) throw error;

      const next = appendContinuation(accumulated, error.partialText);
      if (next.length <= accumulated.length) {
        throw new OutputLimitError(
          `${config.model} made no visible progress before reaching the output limit`,
          accumulated,
          error.responseId,
        );
      }

      accumulated = next;
      previousResponseId = protocol === "responses" ? error.responseId : undefined;
      if (protocol === "responses" && !previousResponseId) {
        throw new ResponsesContinuationUnsupportedError(
          `${config.model} returned an incomplete Responses API result without a response id`,
        );
      }

      if (segment >= maxSegments - 1) {
        throw new OutputLimitError(
          `${config.model} still reached the output limit after ${maxSegments} continuation segments`,
          accumulated,
          previousResponseId,
        );
      }

      currentPrompt = protocol === "responses"
        ? responsesContinuationPrompt()
        : chatContinuationPrompt(prompt, accumulated);
      logContinuation(config, protocol, segment + 2, accumulated.length);
    }
  }

  return accumulated;
}

async function generateChatCompletionsText(
  prompt: string,
  options: GenerateTextOptions | undefined,
  config: AIConfig,
  tokenParameter = chatTokenParameterCache.get(`${config.baseUrl}\n${config.model}`) ?? "max_tokens",
): Promise<string> {
  const maxAttempts = normalizeMaxAttempts(options?.maxAttempts);
  let lastError = "";
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const requestTimeoutMs = options?.timeoutMs ?? config.timeoutMs;
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    const endpoint = chatCompletionsUrl(config.baseUrl);
    const stream = completionStream(config.model, options?.stream);
    const canRetry = attempt < maxAttempts - 1;
    try {
      logModelRequest({
        agent: options?.agent ?? "default",
        model: config.model,
        endpoint,
        stream,
        attempt: attempt + 1,
        mode: "primary",
        protocol: "chat_completions",
        maxOutputTokens: options?.maxTokens ?? config.maxTokens,
      });
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          Accept: stream ? "application/json, text/event-stream" : "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(chatCompletionBody(prompt, options, config, stream, tokenParameter)),
        signal: controller.signal,
      });

      if (response.ok) {
        if (response.headers.get("content-type")?.includes("text/event-stream")) {
          let completion: CompletionExtraction = emptyCompletionExtraction();
          try {
            completion = await readStreamingCompletion(response, controller.signal, options?.onChunk);
          } catch (error) {
            lastError = safeErrorMessage(error, `${config.model} stream interrupted`);
            const fallbackText = await requestNonStreamingCompletion(prompt, options, config, requestTimeoutMs).catch((fallbackError) => {
              lastError = safeErrorMessage(fallbackError, lastError);
              return "";
            });
            if (fallbackText) return fallbackText;
            if (canRetry && isTransientAIError(error)) {
              await waitForRetry(attempt);
              continue;
            }
            throw new Error(lastError);
          }
          if (!completion.text) {
            lastError = emptyCompletionError(config.model, "stream", completion);
            const fallbackText = await requestNonStreamingCompletion(prompt, options, config, requestTimeoutMs).catch((error) => {
              lastError = safeErrorMessage(error, lastError);
              return "";
            });
            if (fallbackText) return fallbackText;
            if (canRetry) {
              await waitForRetry(attempt);
              continue;
            }
            throw new Error(lastError);
          }
          if (isOutputLimitReason(completion.finishReason)) {
            throw new OutputLimitError(
              `${config.model} response truncated by token limit (finish_reason=${completion.finishReason})`,
              completion.text,
            );
          }
          return completion.text;
        }

        const data = await response.json();
        const completion = extractCompletion(data);
        if (!completion.text) {
          lastError = emptyCompletionError(config.model, "response", completion);
          if (canRetry) {
            await waitForRetry(attempt);
            continue;
          }
          throw new Error(lastError);
        }
        if (isOutputLimitReason(completion.finishReason)) {
          throw new OutputLimitError(
            `${config.model} response truncated by token limit (finish_reason=${completion.finishReason})`,
            completion.text,
          );
        }
        return completion.text;
      }

      const body = await response.text();
      const alternateTokenParameter = detectAlternateTokenParameter(response.status, body, tokenParameter);
      if (alternateTokenParameter) {
        chatTokenParameterCache.set(`${config.baseUrl}\n${config.model}`, alternateTokenParameter);
        return generateChatCompletionsText(prompt, options, config, alternateTokenParameter);
      }
      const providerMaxOutput = detectProviderMaxOutputTokens(response.status, body);
      if (providerMaxOutput && providerMaxOutput < (options?.maxTokens ?? config.maxTokens)) {
        return generateChatCompletionsText(
          prompt,
          { ...options, maxTokens: providerMaxOutput },
          config,
          tokenParameter,
        );
      }
      if (options?.responseFormat && attempt === 0 && isResponseFormatUnsupported(response.status, body)) {
        return generateChatCompletionsText(prompt, {
          ...options,
          responseFormat: undefined,
        }, config, tokenParameter);
      }
      if (isChatCompletionsEndpointUnsupported(response.status, body)) {
        throw new ChatCompletionsUnsupportedError(
          `${config.model} does not expose a compatible Chat Completions API: ${response.status} ${safeErrorMessage(body, response.statusText)}`,
        );
      }
      lastError = `${response.status} ${safeErrorMessage(body, response.statusText || "provider error")}`;
      if (![429, 500, 502, 503, 504].includes(response.status) || !canRetry) break;
      await waitForRetry(attempt);
    } catch (error) {
      if (isAbortError(error)) {
        lastError = `request timed out after ${requestTimeoutMs}ms`;
        break;
      }
      lastError = safeErrorMessage(error, `${config.model} request interrupted`);
      if (canRetry && isTransientAIError(error)) {
        await waitForRetry(attempt);
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(`${config.model} request failed: ${lastError}`);
}

type AIConfig = ReturnType<typeof getBaseAIConfig>;

class ResponsesUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResponsesUnsupportedError";
  }
}

class ResponsesContinuationUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResponsesContinuationUnsupportedError";
  }
}

class ChatCompletionsUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatCompletionsUnsupportedError";
  }
}

class OutputLimitError extends Error {
  constructor(
    message: string,
    readonly partialText: string,
    readonly responseId?: string,
  ) {
    super(message);
    this.name = "OutputLimitError";
  }
}

async function generateResponsesText(
  prompt: string,
  options: GenerateTextOptions | undefined,
  config: AIConfig,
  previousResponseId?: string,
) {
  const maxAttempts = normalizeMaxAttempts(options?.maxAttempts);
  let lastError = "";

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const requestTimeoutMs = options?.timeoutMs ?? config.timeoutMs;
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    const endpoint = responsesUrl(config.baseUrl);
    const stream = completionStream(config.model, options?.stream);
    const canRetry = attempt < maxAttempts - 1;

    try {
      logModelRequest({
        agent: options?.agent ?? "default",
        model: config.model,
        endpoint,
        stream,
        attempt: attempt + 1,
        mode: "primary",
        protocol: "responses",
        maxOutputTokens: options?.maxTokens ?? config.maxTokens,
      });
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          Accept: stream ? "application/json, text/event-stream" : "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(responsesBody(prompt, options, config, stream, previousResponseId)),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        if (isResponsesEndpointUnsupported(response.status, body)) {
          throw new ResponsesUnsupportedError(
            `${config.model} does not expose a compatible Responses API: ${response.status} ${safeErrorMessage(body, response.statusText)}`,
          );
        }
        if (previousResponseId && isResponsesContinuationUnsupported(response.status, body)) {
          throw new ResponsesContinuationUnsupportedError(
            `${config.model} does not support Responses continuation: ${response.status} ${safeErrorMessage(body, response.statusText)}`,
          );
        }
        if (options?.responseFormat && isResponseFormatUnsupported(response.status, body)) {
          return generateResponsesText(prompt, { ...options, responseFormat: undefined }, config, previousResponseId);
        }
        const omittedParameter = detectUnsupportedResponsesParameter(response.status, body);
        if (omittedParameter) {
          const key = `${config.baseUrl}\n${config.model}`;
          const omitted = new Set(responsesOmittedParametersCache.get(key) ?? []);
          omitted.add(omittedParameter);
          responsesOmittedParametersCache.set(key, omitted);
          return generateResponsesText(prompt, options, config, previousResponseId);
        }
        const providerMaxOutput = detectProviderMaxOutputTokens(response.status, body);
        if (providerMaxOutput && providerMaxOutput < (options?.maxTokens ?? config.maxTokens)) {
          return generateResponsesText(prompt, { ...options, maxTokens: providerMaxOutput }, config, previousResponseId);
        }
        lastError = `${response.status} ${safeErrorMessage(body, response.statusText || "provider error")}`;
        if (![429, 500, 502, 503, 504].includes(response.status) || !canRetry) {
          throw new Error(`${config.model} Responses API request failed: ${lastError}`);
        }
        await waitForRetry(attempt);
        continue;
      }

      let completion: CompletionExtraction;
      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        completion = await readResponsesStreamingCompletion(response, controller.signal, options?.onChunk);
      } else {
        const data = await response.json();
        if (isRecord(data) && Array.isArray(data.choices) && !Array.isArray(data.output)) {
          throw new ResponsesUnsupportedError(`${config.model} /responses returned Chat Completions payload shape`);
        }
        completion = extractResponsesCompletion(data);
      }
      assertUsableCompletion(config.model, "Responses API", completion);
      return completion.text;
    } catch (error) {
      if (
        error instanceof ResponsesUnsupportedError
        || error instanceof ResponsesContinuationUnsupportedError
        || error instanceof OutputLimitError
      ) throw error;
      if (isAbortError(error)) {
        lastError = `request timed out after ${requestTimeoutMs}ms`;
      } else {
        lastError = safeErrorMessage(error, `${config.model} Responses API request interrupted`);
      }
      if (canRetry && isTransientAIError(error)) {
        await waitForRetry(attempt);
        continue;
      }
      throw error instanceof Error ? error : new Error(lastError);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(`${config.model} Responses API request failed: ${lastError}`);
}

async function requestNonStreamingCompletion(
  prompt: string,
  options: GenerateTextOptions | undefined,
  config: AIConfig,
  timeoutMs: number,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const endpoint = chatCompletionsUrl(config.baseUrl);
  try {
    logModelRequest({
      agent: options?.agent ?? "default",
      model: config.model,
      endpoint,
      stream: false,
      attempt: 1,
      mode: "fallback",
      protocol: "chat_completions",
      maxOutputTokens: options?.maxTokens ?? config.maxTokens,
    });
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(chatCompletionBody(
        prompt,
        options,
        config,
        false,
        chatTokenParameterCache.get(`${config.baseUrl}\n${config.model}`) ?? "max_tokens",
      )),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      if (options?.responseFormat && isResponseFormatUnsupported(response.status, body)) {
        return requestNonStreamingCompletion(prompt, {
          ...options,
          responseFormat: undefined,
        }, config, timeoutMs);
      }
      throw new Error(`${response.status} ${safeErrorMessage(body, response.statusText || "provider error")}`);
    }

    const data = await response.json();
    const completion = extractCompletion(data);
    if (!completion.text) throw new Error(emptyCompletionError(config.model, "non-stream", completion));
    if (isOutputLimitReason(completion.finishReason)) {
      throw new OutputLimitError(
        `${config.model} response truncated by token limit (finish_reason=${completion.finishReason})`,
        completion.text,
      );
    }
    return completion.text;
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(`request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function chatCompletionBody(
  prompt: string,
  options: GenerateTextOptions | undefined,
  config: AIConfig,
  stream: boolean,
  tokenParameter: ChatTokenParameter,
) {
  const responseFormat = options?.responseFormat === "json_object" ? "json_object" : undefined;
  const messages: { role: "system" | "user"; content: string }[] = [{ role: "user", content: prompt }];
  if (responseFormat) {
    messages.unshift({
      role: "system",
      content: "You are a JSON-only API. Return exactly one valid JSON object. Do not include markdown fences, explanations, or any text outside the JSON.",
    });
  }
  const maxOutputTokens = options?.maxTokens ?? config.maxTokens;
  return {
    model: config.model,
    messages,
    temperature: compatibleTemperature(config.model, options?.temperature ?? config.temperature, config.thinking),
    [tokenParameter]: maxOutputTokens,
    stream,
    ...(responseFormat ? { response_format: { type: responseFormat } } : {}),
    ...thinkingPayload(config.model, config.thinking),
  };
}

function responsesBody(
  prompt: string,
  options: GenerateTextOptions | undefined,
  config: AIConfig,
  stream: boolean,
  previousResponseId?: string,
) {
  const key = `${config.baseUrl}\n${config.model}`;
  const omitted = responsesOmittedParametersCache.get(key) ?? new Set();
  const body: Record<string, unknown> = {
    model: config.model,
    input: prompt,
    max_output_tokens: options?.maxTokens ?? config.maxTokens,
    stream,
    ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
    ...(!omitted.has("temperature")
      ? { temperature: compatibleTemperature(config.model, options?.temperature ?? config.temperature, config.thinking) }
      : {}),
    ...(options?.responseFormat === "json_object"
      ? {
          instructions: "Return exactly one valid JSON object. Do not include markdown fences, explanations, or text outside the JSON.",
          text: { format: { type: "json_object" } },
        }
      : {}),
    ...(!omitted.has("thinking") ? thinkingPayload(config.model, config.thinking) : {}),
  };
  return {
    ...body,
  };
}

function isResponsesEndpointUnsupported(status: number, body: string) {
  if ([404, 405, 501].includes(status)) return true;
  return [400, 422].includes(status)
    && /responses|unknown endpoint|unsupported endpoint|not found|invalid url|unknown path/i.test(body);
}

function isResponsesContinuationUnsupported(status: number, body: string) {
  return [400, 404, 405, 422, 501].includes(status)
    && /previous_response_id|previous response|continuation|stateful/i.test(body);
}

function isChatCompletionsEndpointUnsupported(status: number, body: string) {
  if ([404, 405, 501].includes(status)) return true;
  return [400, 422].includes(status)
    && /chat\/completions|chat completions endpoint|unknown endpoint|unsupported endpoint|unknown path|invalid url/i.test(body);
}

function detectUnsupportedResponsesParameter(
  status: number,
  body: string,
): "temperature" | "thinking" | undefined {
  if (![400, 422].includes(status)) return undefined;
  if (/temperature/i.test(body) && /unsupported|unknown|not allowed|invalid parameter/i.test(body)) {
    return "temperature";
  }
  if (/thinking/i.test(body) && /unsupported|unknown|not allowed|invalid parameter/i.test(body)) {
    return "thinking";
  }
  return undefined;
}

function detectAlternateTokenParameter(
  status: number,
  body: string,
  current: ChatTokenParameter,
): ChatTokenParameter | undefined {
  if (![400, 422].includes(status)) return undefined;
  if (current === "max_tokens"
    && /max_tokens/i.test(body)
    && /max_completion_tokens/i.test(body)
    && /unsupported|use|instead|unknown|not supported/i.test(body)) {
    return "max_completion_tokens";
  }
  if (current === "max_completion_tokens"
    && /max_completion_tokens/i.test(body)
    && /max_tokens/i.test(body)
    && /unsupported|use|instead|unknown|not supported/i.test(body)) {
    return "max_tokens";
  }
  return undefined;
}

function detectProviderMaxOutputTokens(status: number, body: string) {
  if (![400, 413, 422].includes(status)) return undefined;
  if (!/max(?:imum)?[_\s-]*(?:output|completion)?[_\s-]*tokens?|token limit|must be (?:less than|at most|<=)/i.test(body)) {
    return undefined;
  }
  const candidates = [
    ...body.matchAll(/(?:maximum|max(?:imum)?(?:[_\s-]*(?:output|completion))?[_\s-]*tokens?|at most|less than or equal to|<=)\D{0,32}(\d{3,7})/gi),
  ]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value >= 256);
  return candidates.length ? Math.min(...candidates) : undefined;
}

function isResponseFormatUnsupported(status: number, body: string) {
  return [400, 422].includes(status) && /response_format|json_object|json\s*mode|unsupported|unknown/i.test(body);
}

function compatibleTemperature(
  model: string,
  temperature: number,
  thinking: "disabled" | "enabled" | "auto",
) {
  if (isKimiK27CodeModel(model)) return 1;
  if (isKimiThinkingModel(model) && thinking !== "auto") return 0.6;
  return temperature;
}

function completionStream(_model: string, requested: boolean | undefined) {
  if (requested !== undefined) return requested;
  return true;
}

function waitForRetry(attempt: number) {
  return new Promise((resolve) => setTimeout(resolve, 1200 * (attempt + 1)));
}

function normalizeMaxAttempts(value: number | undefined) {
  if (value === undefined) return 3;
  if (!Number.isFinite(value)) return 3;
  return Math.max(1, Math.min(5, Math.floor(value)));
}

type CompletionExtraction = {
  text: string;
  reasoningLength: number;
  finishReason?: string;
  status?: string;
  responseId?: string;
};

function emptyCompletionExtraction(): CompletionExtraction {
  return { text: "", reasoningLength: 0 };
}

async function readStreamingCompletion(response: Response, signal: AbortSignal, onChunk?: (chunk: string) => void) {
  const completion = emptyCompletionExtraction();
  const reader = response.body?.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  const consumeLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (data === "[DONE]") return;
    try {
      const parsed = JSON.parse(data);
      const extracted = extractCompletion(parsed);
      if (extracted.text) {
        completion.text += extracted.text;
        onChunk?.(extracted.text);
      }
      completion.reasoningLength += extracted.reasoningLength;
      if (extracted.finishReason) completion.finishReason = extracted.finishReason;
    } catch {
      // Ignore malformed provider keepalive chunks.
    }
  };

  if (reader) {
    const cancelReader = () => {
      void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener("abort", cancelReader, { once: true });
    try {
      while (true) {
        throwIfAborted(signal);
        const { done, value } = await reader.read();
        throwIfAborted(signal);
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) consumeLine(line);
      }
    } finally {
      signal.removeEventListener("abort", cancelReader);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consumeLine(buffer);
  }

  return completion;
}

async function readResponsesStreamingCompletion(
  response: Response,
  signal: AbortSignal,
  onChunk?: (chunk: string) => void,
) {
  const completion = emptyCompletionExtraction();
  const reader = response.body?.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  const consumeEvent = (raw: string) => {
    const dataLines = raw
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    if (!dataLines.length) return;
    const data = dataLines.join("\n");
    if (!data || data === "[DONE]") return;
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      const type = typeof parsed.type === "string" ? parsed.type : "";
      if (type === "response.output_text.delta" && typeof parsed.delta === "string") {
        completion.text += parsed.delta;
        onChunk?.(parsed.delta);
      } else if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
        const final = extractResponsesCompletion(parsed.response);
        if (!completion.text && final.text) completion.text = final.text;
        completion.reasoningLength = Math.max(completion.reasoningLength, final.reasoningLength);
        completion.finishReason = final.finishReason;
        completion.status = final.status;
        completion.responseId = final.responseId;
      }
    } catch {
      // Ignore malformed provider keepalive events.
    }
  };

  if (reader) {
    const cancelReader = () => {
      void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener("abort", cancelReader, { once: true });
    try {
      while (true) {
        throwIfAborted(signal);
        const { done, value } = await reader.read();
        throwIfAborted(signal);
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/u);
        buffer = events.pop() ?? "";
        for (const event of events) consumeEvent(event);
      }
    } finally {
      signal.removeEventListener("abort", cancelReader);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consumeEvent(buffer);
  }

  return completion;
}

function throwIfAborted(signal: AbortSignal) {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("The operation was aborted.", "AbortError");
}

function isAbortError(error: unknown) {
  return error instanceof Error && (error.name === "AbortError" || /abort|aborted/i.test(error.message));
}

function isTransientAIError(error: unknown) {
  const message = errorText(error);
  return /fetch failed|terminated|socket|network|econnreset|etimedout|eai_again|und_err|other side closed/i.test(message);
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error ?? "");
  const cause = (error as Error & { cause?: unknown }).cause;
  return `${error.name} ${error.message} ${cause instanceof Error ? `${cause.name} ${cause.message}` : String(cause ?? "")}`;
}

function extractCompletion(data: unknown): CompletionExtraction {
  const choice = (data as { choices?: Array<Record<string, unknown>> })?.choices?.[0];
  if (!choice) return emptyCompletionExtraction();
  const delta = choice.delta as { content?: unknown; reasoning_content?: unknown } | undefined;
  const message = choice.message as { content?: unknown; reasoning_content?: unknown } | undefined;
  const text = choice.text;
  const content = typeof delta?.content === "string"
    ? delta.content
    : typeof message?.content === "string"
      ? message.content
      : typeof text === "string"
        ? text
        : "";
  const reasoning = typeof delta?.reasoning_content === "string"
    ? delta.reasoning_content
    : typeof message?.reasoning_content === "string"
      ? message.reasoning_content
      : "";
  const finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : undefined;
  return {
    text: content,
    reasoningLength: reasoning.length,
    finishReason,
  };
}

function extractResponsesCompletion(data: unknown): CompletionExtraction {
  const record = isRecord(data) ? data : {};
  const output = Array.isArray(record.output) ? record.output : [];
  let text = "";
  let reasoningLength = 0;

  for (const item of output) {
    if (!isRecord(item)) continue;
    if (item.type === "reasoning") {
      reasoningLength += JSON.stringify(item).length;
      continue;
    }
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (!isRecord(part)) continue;
      if ((part.type === "output_text" || part.type === "text") && typeof part.text === "string") {
        text += part.text;
      }
    }
  }

  const status = typeof record.status === "string" ? record.status : undefined;
  const responseId = typeof record.id === "string" ? record.id : undefined;
  const details = isRecord(record.incomplete_details) ? record.incomplete_details : {};
  const finishReason = typeof details.reason === "string"
    ? details.reason
    : status === "incomplete"
      ? "incomplete"
      : undefined;
  return { text, reasoningLength, finishReason, status, responseId };
}

function assertUsableCompletion(model: string, kind: string, completion: CompletionExtraction) {
  if (completion.status === "failed") {
    throw new Error(`${model} returned a failed ${kind} response`);
  }
  if (completion.status === "incomplete") {
    throw new OutputLimitError(
      `${model} returned an incomplete ${kind} response${completion.finishReason ? ` (${completion.finishReason})` : ""}`,
      completion.text,
      completion.responseId,
    );
  }
  if (isOutputLimitReason(completion.finishReason)) {
    throw new OutputLimitError(
      `${model} response truncated by token limit (${completion.finishReason})`,
      completion.text,
      completion.responseId,
    );
  }
  if (!completion.text) {
    throw new Error(emptyCompletionError(model, "response", completion));
  }
}

function isOutputLimitReason(reason: string | undefined) {
  return reason === "length"
    || reason === "max_tokens"
    || reason === "max_output_tokens"
    || reason === "max_completion_tokens";
}

function normalizeContinuationSegments(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return 4;
  return Math.max(2, Math.min(8, Math.floor(value)));
}

function responsesContinuationPrompt() {
  return [
    "Continue the previous answer exactly where it stopped.",
    "Output only the missing continuation, with no preface and no repetition.",
    "Preserve the existing Markdown structure, numbering, terminology, and notation.",
    "Complete every remaining requirement from the original task, including required closing sections.",
  ].join(" ");
}

function chatContinuationPrompt(originalPrompt: string, accumulated: string) {
  const tail = accumulated.slice(-8000);
  return `${originalPrompt}

# Continuation task

The previous answer was cut off by the provider output limit.
Continue exactly after the draft tail below. Output only the missing continuation.
Do not repeat headings, paragraphs, formulas, tables, or figure placeholders already present.
Preserve numbering, terminology, notation, and Markdown structure, and complete every remaining requirement.

<draft_tail>
${tail}
</draft_tail>`;
}

function appendContinuation(existing: string, continuation: string) {
  if (!existing) return continuation;
  if (!continuation) return existing;
  const maxOverlap = Math.min(2000, existing.length, continuation.length);
  for (let size = maxOverlap; size >= 32; size -= 1) {
    if (existing.slice(-size) === continuation.slice(0, size)) {
      return existing + continuation.slice(size);
    }
  }
  const separator = existing.endsWith("\n") || continuation.startsWith("\n") ? "" : "\n";
  return `${existing}${separator}${continuation}`;
}

function alternateProtocol(protocol: ProviderProtocol): ProviderProtocol {
  return protocol === "responses" ? "chat_completions" : "responses";
}

function logProtocolFallback(
  config: AIConfig,
  from: ProviderProtocol,
  to: ProviderProtocol,
  error: unknown,
) {
  console.info(JSON.stringify({
    event: "learnbyai.ai_protocol_fallback",
    at: new Date().toISOString(),
    model: config.model,
    endpoint: publicEndpoint(from === "responses" ? responsesUrl(config.baseUrl) : chatCompletionsUrl(config.baseUrl)),
    from,
    to,
    reason: safeErrorMessage(error, `${from} unavailable`),
  }));
}

function logContinuation(
  config: AIConfig,
  protocol: ProviderProtocol,
  segment: number,
  accumulatedCharacters: number,
) {
  if (process.env.AI_REQUEST_LOGS === "false") return;
  console.info(JSON.stringify({
    event: "learnbyai.ai_continuation",
    at: new Date().toISOString(),
    model: config.model,
    protocol,
    segment,
    accumulatedCharacters,
  }));
}

function emptyCompletionError(model: string, kind: "stream" | "response" | "non-stream", completion: CompletionExtraction) {
  let message = `${model} returned an empty ${kind} response`;
  if (completion.reasoningLength > 0) {
    message += "; provider returned reasoning_content but no content, so thinking mode likely consumed the output tokens. Set thinking to disabled for Kimi thinking models.";
  }
  if (completion.finishReason) {
    message += ` finish_reason=${completion.finishReason}.`;
  }
  return message;
}

function thinkingPayload(model: string, thinking: "disabled" | "enabled" | "auto") {
  if (thinking !== "enabled") return {};
  return { thinking: { type: "enabled" } };
}

function isKimiK27CodeModel(model: string) {
  return /^kimi-k2\.7-code$/i.test(model.trim().toLowerCase());
}

function isKimiThinkingModel(model: string) {
  return /^kimi-k/i.test(model.trim().toLowerCase());
}

function logModelRequest(input: {
  agent: AgentName | "default";
  model: string;
  endpoint: string;
  stream: boolean;
  attempt: number;
  mode: "primary" | "fallback";
  protocol: ProviderProtocol;
  maxOutputTokens: number;
}) {
  if (process.env.AI_REQUEST_LOGS === "false") return;
  console.info(JSON.stringify({
    event: "learnbyai.ai_request",
    at: new Date().toISOString(),
    agent: input.agent,
    model: input.model,
    endpoint: publicEndpoint(input.endpoint),
    stream: input.stream,
    attempt: input.attempt,
    mode: input.mode,
    protocol: input.protocol,
    maxOutputTokens: input.maxOutputTokens,
  }));
}

function publicEndpoint(endpoint: string) {
  try {
    const url = new URL(endpoint);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return `${url.origin}${url.pathname}`;
  } catch {
    return "[invalid-endpoint]";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}


function escapeControlCharsInJsonStrings(text: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? "";
    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      result += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      result += char;
      continue;
    }
    if (inString) {
      if (char === "\n") {
        result += "\\n";
      } else if (char === "\r") {
        result += "\\r";
      } else if (char === "\t") {
        result += "\\t";
      } else {
        result += char;
      }
    } else {
      result += char;
    }
  }
  return result;
}

export function parseJson<T>(text: string): T {
  const extracted = extractJsonObjectText(text);
  const repaired = repairInvalidJsonEscapes(extracted);
  const cleaned = escapeControlCharsInJsonStrings(repaired)
    .replace(/[\u200B-\u200D\uFEFF\u2060\u00AD]/gu, "");
  return JSON.parse(cleaned) as T;
}
