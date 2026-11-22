/**
 * One place that turns "something went wrong talking to the LLM" into a decision:
 * retry, shrink the prompt, or stop and tell the user what to fix.
 *
 * Before this, every failure looked the same in the chat ("LLM connection problem … Retrying…"), so a
 * rejected API key was retried three times and a provider queue was blamed on the model.
 */

export type LlmErrorClass =
  | "auth"
  | "rate_limit"
  | "context_length"
  | "bad_request"
  | "upstream"
  | "network"
  | "timeout"
  | "aborted"
  | "unknown";

export type LlmErrorInfo = {
  class: LlmErrorClass;
  /** What the user reads. Short, specific, no stack traces. */
  message: string;
  retryable: boolean;
  /** Wait this long before the next attempt (from Retry-After when the provider sends it). */
  retryAfterMs?: number;
  /** What the user can do about it. */
  hint?: string;
  status?: number;
};

const RETRY_AFTER_CAP_MS = 20_000;

export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(RETRY_AFTER_CAP_MS, Math.round(secs * 1000));
  const at = Date.parse(value);
  if (!Number.isNaN(at)) return Math.max(0, Math.min(RETRY_AFTER_CAP_MS, at - Date.now()));
  return undefined;
}

const CONTEXT_RE = /context[ _-]?(length|window|limit)|maximum context|too many (input )?tokens|prompt is too long|request too large|reduce the length/i;

export function classifyLlmError(input: {
  status?: number;
  message?: string;
  body?: string;
  retryAfter?: string | null;
  aborted?: boolean;
}): LlmErrorInfo {
  const status = input.status;
  const raw = `${input.message ?? ""} ${input.body ?? ""}`.trim();
  const body = (input.body ?? "").slice(0, 400);
  const retryAfterMs = parseRetryAfter(input.retryAfter);

  if (input.aborted || /AbortError|The operation was aborted|request cancelled|499/i.test(raw)) {
    return { class: "aborted", message: "The request was cancelled.", retryable: false, status };
  }
  if (/no answer from the LLM within|\bstopped sending data\b|TimeoutError|timed out|ETIMEDOUT/i.test(raw)) {
    return {
      class: "timeout",
      message: input.message?.slice(0, 200) || "The endpoint did not answer in time.",
      retryable: true,
      retryAfterMs,
      hint: "The provider is queueing or unreachable. A retry often works; if it keeps happening, try another model or endpoint.",
      status,
    };
  }
  if (/fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network|getaddrinfo/i.test(raw)) {
    return {
      class: "network",
      message: "The app could not reach the endpoint (network/DNS).",
      retryable: true,
      retryAfterMs,
      hint: "Check the Base URL in Settings, and whether this machine can reach that host (VPN/proxy/DNS).",
      status,
    };
  }
  if (status === 401 || status === 403) {
    return {
      class: "auth",
      message: `The endpoint rejected the credentials (HTTP ${status}).`,
      retryable: false,
      hint: "Open Settings → Test connection. If it fails there too, the API key is wrong, expired, or not allowed for this model.",
      status,
    };
  }
  if (status === 429) {
    return {
      class: "rate_limit",
      message: "The endpoint is rate-limiting this app (HTTP 429).",
      retryable: true,
      retryAfterMs: retryAfterMs ?? 3_000,
      hint: "Short waits usually clear it. A paid tier or a different model has a higher limit.",
      status,
    };
  }
  if (status === 404) {
    return {
      class: "bad_request",
      message: "The endpoint answered HTTP 404 — the Base URL probably points to the wrong path.",
      retryable: false,
      hint: "OpenAI-compatible endpoints usually end in /v1 (e.g. https://host/v1). Settings → Test connection shows the exact URL.",
      status,
    };
  }
  if (status === 400 || status === 413 || status === 422) {
    if (CONTEXT_RE.test(raw)) {
      return {
        class: "context_length",
        message: "This conversation no longer fits in the model's context window.",
        retryable: true,
        hint: "The app will shorten the older part of the chat and retry. Starting a new model keeps long sessions fast.",
        status,
      };
    }
    return {
      class: "bad_request",
      message: `The endpoint rejected the request (HTTP ${status})${body ? `: ${body}` : "."}`,
      retryable: false,
      hint: "Usually a model name that this endpoint does not serve, or a sampling setting it does not accept (temperature/max tokens). Settings → Test connection checks the model name.",
      status,
    };
  }
  if (status && status >= 500) {
    return {
      class: "upstream",
      message: `The provider returned a server error (HTTP ${status}).`,
      retryable: true,
      retryAfterMs,
      hint: "Provider-side; retrying is usually enough.",
      status,
    };
  }
  if (status === 499) {
    return { class: "aborted", message: "The request was cancelled while waiting for a free LLM slot.", retryable: true, status };
  }
  return {
    class: "unknown",
    message: input.message?.slice(0, 240) || "Unknown LLM failure.",
    retryable: true,
    retryAfterMs,
    hint: "Open the connection diagnostics in the chat header to copy the details.",
    status,
  };
}

/** Backoff that respects the provider's own Retry-After but never hammers it. */
export function backoffMs(attempt: number, info: LlmErrorInfo): number {
  const base = info.retryAfterMs ?? Math.min(16_000, 1_200 * 2 ** attempt);
  const jitter = Math.round(base * 0.15 * Math.random());
  return Math.max(400, base + jitter);
}

/** One-line summary used by the header chip and the diagnostics list. */
export function describeLlmError(info: LlmErrorInfo): string {
  return `${info.class}: ${info.message}`;
}
