import { describe, expect, it } from "vitest";
import { backoffMs, classifyLlmError, parseRetryAfter } from "@/lib/llm-errors";
import { diffLines } from "@/client/model/diff";

describe("classifyLlmError", () => {
  it("does not retry a rejected key, and tells the user what to fix", () => {
    const info = classifyLlmError({ status: 401, message: "LLM HTTP 401: invalid api key" });
    expect(info.class).toBe("auth");
    expect(info.retryable).toBe(false);
    expect(info.hint).toMatch(/Settings/);
  });
  it("retries a rate limit and honours Retry-After", () => {
    const info = classifyLlmError({ status: 429, message: "slow down", retryAfter: "7" });
    expect(info.class).toBe("rate_limit");
    expect(info.retryable).toBe(true);
    expect(info.retryAfterMs).toBe(7000);
  });
  it("recognises a context overflow instead of blaming the network", () => {
    const info = classifyLlmError({ status: 400, body: "This model's maximum context length is 65536 tokens" });
    expect(info.class).toBe("context_length");
    expect(info.retryable).toBe(true);
  });
  it("treats a 404 as a wrong Base URL path", () => {
    const info = classifyLlmError({ status: 404, message: "not found" });
    expect(info.class).toBe("bad_request");
    expect(info.retryable).toBe(false);
    expect(info.hint).toMatch(/\/v1/);
  });
  it("separates a timeout from a network failure", () => {
    expect(classifyLlmError({ message: "no answer from the LLM within 240s (the endpoint is queuing or unreachable)" }).class).toBe("timeout");
    expect(classifyLlmError({ message: "fetch failed" }).class).toBe("network");
    // The idle watchdog aborts the upstream; that is a timeout the app retries, never "the user cancelled it".
    const idle = classifyLlmError({ message: "the LLM stopped sending data for 120s" });
    expect(idle.class).toBe("timeout");
    expect(idle.retryable).toBe(true);
  });
  it("never retries an abort", () => {
    const info = classifyLlmError({ aborted: true, message: "AbortError" });
    expect(info.class).toBe("aborted");
    expect(info.retryable).toBe(false);
  });
  it("keeps a server error retryable", () => {
    expect(classifyLlmError({ status: 503, message: "upstream" }).class).toBe("upstream");
    expect(classifyLlmError({ status: 503, message: "upstream" }).retryable).toBe(true);
  });
});

describe("backoffMs", () => {
  it("prefers the provider's Retry-After over its own curve", () => {
    const info = classifyLlmError({ status: 429, message: "x", retryAfter: "5" });
    const wait = backoffMs(0, info);
    expect(wait).toBeGreaterThanOrEqual(5000);
    expect(wait).toBeLessThan(6000);
  });
  it("grows with the attempt number", () => {
    const info = classifyLlmError({ status: 503, message: "x" });
    expect(backoffMs(3, info)).toBeGreaterThan(backoffMs(0, info));
  });
});

describe("parseRetryAfter", () => {
  it("reads seconds and HTTP dates", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(new Date(Date.now() + 4000).toUTCString())).toBeGreaterThan(1000);
  });
});

describe("diffLines", () => {
  it("reports added and removed lines with context", () => {
    const before = "to setup\n  clear-all\n  create-turtles 10\nend";
    const after = "to setup\n  clear-all\n  create-sheep 10\n  reset-ticks\nend";
    const d = diffLines(before, after);
    expect(d.added).toBe(2);
    expect(d.removed).toBe(1);
    expect(d.lines.some((l) => l.k === "+" && l.text.includes("create-sheep"))).toBe(true);
    expect(d.lines.some((l) => l.k === "-" && l.text.includes("create-turtles"))).toBe(true);
  });
  it("is empty for identical text", () => {
    const d = diffLines("same\ntext", "same\ntext");
    expect(d.added).toBe(0);
    expect(d.removed).toBe(0);
  });
});
