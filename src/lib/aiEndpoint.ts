export function chatCompletionsUrl(baseUrl: string) {
  return providerEndpointUrl(baseUrl, "chat/completions");
}

export function responsesUrl(baseUrl: string) {
  return providerEndpointUrl(baseUrl, "responses");
}

function providerEndpointUrl(baseUrl: string, endpoint: "chat/completions" | "responses") {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    throw new Error("AI base URL is not configured.");
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("AI base URL must be an absolute http(s) URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("AI base URL must use http or https.");
  }

  url.search = "";
  url.hash = "";

  let pathname = url.pathname.replace(/\/+$/u, "");
  pathname = pathname
    .replace(/\/chat\/completions$/iu, "")
    .replace(/\/responses$/iu, "");
  if (!pathname || pathname === "/") pathname = "/v1";

  url.pathname = `${pathname}/${endpoint}`;
  return url.toString().replace(/\/$/u, "");
}
