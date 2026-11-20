import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

let cfg: typeof import("@/lib/llm-config");
let sec: typeof import("@/lib/secrets");

beforeAll(async () => {
  process.env.DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nlchat-cfg-")), "t.db");
  process.env.LLM_BASE_URL = "https://server.example/v1";
  process.env.LLM_API_KEY = "server-key";
  process.env.LLM_MODEL = "server-model";
  process.env.LLM_ALLOW_PRIVATE_HOSTS = "false";
  cfg = await import("@/lib/llm-config");
  sec = await import("@/lib/secrets");
});

describe("secrets", () => {
  it("round-trips, uses a fresh IV, and rejects tampering", () => {
    const a = sec.encryptSecret("sk-abcdef123456");
    const b = sec.encryptSecret("sk-abcdef123456");
    expect(a).not.toBe(b);
    expect(a).not.toContain("sk-abcdef");
    expect(sec.decryptSecret(a)).toBe("sk-abcdef123456");
    const parts = a.split(":");
    parts[3] = Buffer.from("garbage-garbage-garbage").toString("base64");
    expect(sec.decryptSecret(parts.join(":"))).toBeNull();
    expect(sec.decryptSecret("not-a-secret")).toBeNull();
  });
  it("hint reveals at most the last 4 characters", () => {
    expect(sec.keyHint("sk-abcdef123456")).toBe("••••3456");
    expect(sec.keyHint("short")).toBe("••••");
  });
});

describe("normalizeBaseUrl", () => {
  it.each([
    ["https://api.openai.com/v1/", "https://api.openai.com/v1"],
    ["https://api.openai.com/v1/chat/completions", "https://api.openai.com/v1"],
    ["https://x.io/v1//", "https://x.io/v1"],
    ["localhost:11434/v1", "http://localhost:11434/v1"],
    ["  http://h:8000/v1  ", "http://h:8000/v1"],
  ])("%s", (inp, out) => expect(cfg.normalizeBaseUrl(inp)).toBe(out));
});

describe("private address detection", () => {
  it.each(["127.0.0.1", "10.1.2.3", "192.168.0.5", "172.16.0.1", "172.31.255.255", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "0.0.0.0"])("%s is private", (ip) => expect(cfg.isPrivateAddress(ip)).toBe(true));
  it.each(["8.8.8.8", "172.32.0.1", "172.15.0.1", "1.1.1.1", "2606:4700:4700::1111", "100.128.0.1"])("%s is public", (ip) => expect(cfg.isPrivateAddress(ip)).toBe(false));
});

describe("assertAllowedEndpoint (LLM_ALLOW_PRIVATE_HOSTS=false)", () => {
  it("blocks loopback, metadata, LAN ip and bad schemes; allows public ip", async () => {
    await expect(cfg.assertAllowedEndpoint("http://127.0.0.1:8000/v1")).rejects.toThrow(/private/i);
    await expect(cfg.assertAllowedEndpoint("http://169.254.169.254/latest")).rejects.toThrow(/private/i);
    await expect(cfg.assertAllowedEndpoint("http://[::1]:1/v1")).rejects.toThrow(/private/i);
    await expect(cfg.assertAllowedEndpoint("http://192.168.1.2/v1")).rejects.toThrow(/private/i);
    await expect(cfg.assertAllowedEndpoint("file:///etc/passwd")).rejects.toThrow(/http/);
    await expect(cfg.assertAllowedEndpoint("http://user:pw@8.8.8.8/v1")).rejects.toThrow(/API key field/);
    await expect(cfg.assertAllowedEndpoint("not a url")).rejects.toThrow();
    await expect(cfg.assertAllowedEndpoint("https://8.8.8.8/v1")).resolves.toBeUndefined();
  });
});

describe("storage and resolution", () => {
  it("uses only connections the user saved — the built-in default is gone", () => {
    expect(cfg.resolveLlm("u1")).toBeNull();
    cfg.saveUserSettings("u1", cfg.settingsInput.parse({ baseUrl: "https://my.host/v1/", model: "my-model", apiKey: "sk-secretsecret9999", temperature: null, thinking: "omit" }));
    const r = cfg.resolveLlm("u1")!;
    expect(r).toMatchObject({ source: "user", baseUrl: "https://my.host/v1", model: "my-model", apiKey: "sk-secretsecret9999", temperature: null });
    const pub = cfg.publicSettings("u1");
    expect(JSON.stringify(pub)).not.toContain("secretsecret");
    expect(pub.user).toMatchObject({ hasKey: true, keyHint: "••••9999" });
    // another user is unaffected
    expect(cfg.resolveLlm("u2")).toBeNull();
  });

  it("empty apiKey keeps the saved key; clearKey removes it", () => {
    cfg.saveUserSettings("u1", cfg.settingsInput.parse({ baseUrl: "https://my.host/v1", model: "m2" }));
    expect(cfg.resolveLlm("u1")).toMatchObject({ model: "m2", apiKey: "sk-secretsecret9999" });
    cfg.saveUserSettings("u1", cfg.settingsInput.parse({ baseUrl: "https://my.host/v1", model: "m2", clearKey: true }));
    expect(cfg.resolveLlm("u1")?.apiKey).toBe("");
  });

  it("deleting the saved connections leaves no LLM configured", () => {
    cfg.deleteUserSettings("u1");
    expect(cfg.resolveLlm("u1")).toBeNull();
  });

  it("remembers skipping API setup until a connection is saved", () => {
    expect(cfg.apiSetupSkipped("u4")).toBe(false);
    cfg.setApiSetupSkipped("u4", true);
    expect(cfg.apiSetupSkipped("u4")).toBe(true);
    cfg.saveUserSettings("u4", cfg.settingsInput.parse({ baseUrl: "https://my.host/v1", model: "my-model" }));
    expect(cfg.apiSetupSkipped("u4")).toBe(false);
  });

  it("an undecryptable stored key is reported instead of sending garbage", async () => {
    const { db } = await import("@/lib/db");
    db().prepare("INSERT OR REPLACE INTO user_settings (user_id, data, updated_at) VALUES (?, ?, ?)").run("u3", JSON.stringify({ baseUrl: "https://a/v1", model: "x", apiKeyEnc: "v1:AAAA:BBBB:CCCC", temperature: 0.2, thinking: "omit" }), 1);
    expect(cfg.resolveLlm("u3")).toBeNull();
    expect(cfg.publicSettings("u3").user?.keyUnreadable).toBe(true);
  });
});

describe("request building", () => {
  const base = { protocol: "openai" as const, maxTokens: null, baseUrl: "x", apiKey: "k", model: "m", source: "user" as const };
  it("omits optional parameters when configured so", () => {
    const p = cfg.chatPayload({ ...base, temperature: null, thinking: "omit" }, [{ role: "user", content: "hi" }], [], true);
    expect(p).toEqual({ model: "m", messages: [{ role: "user", content: "hi" }], stream: true });
  });
  it("sends temperature, thinking flag and tools when set", () => {
    const p = cfg.chatPayload({ ...base, temperature: 0.2, thinking: "off" }, [], [{ type: "function" }], false);
    expect(p).toMatchObject({ temperature: 0.2, chat_template_kwargs: { enable_thinking: false }, tool_choice: "auto", stream: false });
  });
  it("no Authorization header without a key", () => {
    expect(cfg.authHeaders({ apiKey: "" })).toEqual({ "Content-Type": "application/json" });
    expect(cfg.authHeaders({ apiKey: "abc" }).Authorization).toBe("Bearer abc");
  });
});
