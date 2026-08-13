export type AIProtocol = "responses" | "chat_completions";
export type AIProtocolPreference = "auto" | AIProtocol;

export function resolveAIProtocolOrder(input: {
  preference?: AIProtocolPreference;
  responseFormat?: "json_object";
  continueOnOutputLimit?: boolean;
}): AIProtocol[] {
  const preferred = input.preference && input.preference !== "auto"
    ? input.preference
    : input.responseFormat
      ? "responses"
      : "chat_completions";

  return preferred === "responses"
    ? ["responses", "chat_completions"]
    : ["chat_completions", "responses"];
}
