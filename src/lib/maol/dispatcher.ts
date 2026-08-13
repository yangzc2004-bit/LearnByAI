import { generateText } from "../ai";
import { AIProtocolPreference } from "../aiProtocol";
import { appendJobEvent } from "../jobs";
import { ModelOverrides } from "../modelOverrides";
import { redactSecrets, safeErrorMessage } from "../safeError";
import { AgentName, GenerationJob } from "../types";
import { canCallAgent, resolveAgent } from "./registry";

export async function dispatchAgentText(input: {
  agent: AgentName;
  prompt: string;
  jobId?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  stream?: boolean;
  responseFormat?: "json_object";
  protocol?: AIProtocolPreference;
  continueOnOutputLimit?: boolean;
  maxContinuationSegments?: number;
  continuationPrompt?: (input: {
    originalPrompt: string;
    accumulatedText: string;
    segment: number;
    responseId?: string;
    providerStateUnavailable: boolean;
  }) => string;
  continuationUsePreviousResponseId?: boolean;
  validateContinuation?: (text: string, accumulatedText: string) => void;
  overrides?: ModelOverrides;
  mock?: () => string;
  onChunk?: (chunk: string) => void;
  onJobUpdate?: (job: GenerationJob) => Promise<void> | void;
}) {
  if (input.jobId) {
    await appendAndPersist(input.jobId, {
      agent: input.agent,
      status: "running",
      message: `${input.agent} started.`,
    }, input.onJobUpdate);
  }

  try {
    if (!canCallAgent(input.agent, input.overrides)) {
      const text = input.mock?.() ?? "";
      if (input.jobId) {
        await appendAndPersist(input.jobId, {
          agent: input.agent,
          status: "succeeded",
          message: `${input.agent} returned mock output.`,
        }, input.onJobUpdate);
      }
      return text;
    }

    const config = resolveAgent(input.agent, input.overrides);
    const text = await generateText(input.prompt, {
      agent: input.agent,
      temperature: input.temperature ?? config.temperature,
      maxTokens: input.maxTokens ?? config.maxTokens,
      timeoutMs: input.timeoutMs,
      maxAttempts: input.maxAttempts,
      stream: input.stream,
      responseFormat: input.responseFormat,
      protocol: input.protocol,
      continueOnOutputLimit: input.continueOnOutputLimit,
      maxContinuationSegments: input.maxContinuationSegments,
      continuationPrompt: input.continuationPrompt,
      continuationUsePreviousResponseId: input.continuationUsePreviousResponseId,
      validateContinuation: input.validateContinuation,
      overrides: input.overrides,
      onChunk: input.onChunk,
    });

    if (input.jobId) {
      await appendAndPersist(input.jobId, {
        agent: input.agent,
        status: "succeeded",
        message: `${input.agent} completed.`,
      }, input.onJobUpdate);
    }

    return text;
  } catch (error) {
    if (input.jobId) {
      await appendAndPersist(input.jobId, {
        agent: input.agent,
        status: "failed",
        message: `${input.agent} failed (${classifyAgentFailure(error)}).`,
      }, input.onJobUpdate);
    }
    throw error;
  }
}

export function classifyAgentFailure(error: unknown) {
  const message = redactSecrets(error).toLowerCase();
  if (message.includes("no visible progress") || message.includes("output limit")) {
    return "provider_output_limit";
  }
  if (message.includes("timed out") || message.includes("timeout") || message.includes("abort")) {
    return "provider_timeout";
  }
  if (message.includes("429") || message.includes("rate limit")) {
    return "provider_rate_limit";
  }
  if (/\b(?:500|502|503|504|522)\b/u.test(message) || message.includes("unavailable")) {
    return "provider_unavailable";
  }
  if (message.includes("harness") || message.includes("contract")) {
    return "harness_validation";
  }
  if (message.includes("responses api")) {
    return "responses_transport";
  }
  return safeErrorMessage(error, "provider_error") === "provider_error"
    ? "provider_error"
    : "provider_rejected";
}

async function appendAndPersist(
  jobId: string,
  event: Parameters<typeof appendJobEvent>[1],
  onJobUpdate?: (job: GenerationJob) => Promise<void> | void,
) {
  const job = appendJobEvent(jobId, event, { preserveJobStatus: true });
  if (job && onJobUpdate) {
    await onJobUpdate(job);
  }
  return job;
}
