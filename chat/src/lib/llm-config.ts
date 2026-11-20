import dns from "node:dns/promises";
import net from "node:net";
import { z } from "zod";
import { env } from "./env";
import { db } from "./db";
import { decryptSecret, encryptSecret, keyHint } from "./secrets";

export const thinkingModes = ["off", "on", "omit"] as const;
export const protocols = ["openai", "anthropic"] as const;
export type Protocol = (typeof protocols)[number];
export type ThinkingMode = (typeof thinkingModes)[number];

/** What the user can change in Settings. `apiKey` is only ever accepted as input, never returned. */
export const settingsInput = z.object({
  protocol: z.enum(protocols).default("openai"),
  baseUrl: z.string().trim().min(1).max(300),
  model: z.string().trim().min(1).max(200),
  maxTokens: z.number().int().min(16).max(200000).nullable().default(null),
  apiKey: z.string().max(500).optional(),
  clearKey: z.boolean().optional(),
  temperature: z.number().min(0).max(2).nullable().default(0.2),
  thinking: z.enum(thinkingModes).default("omit"),
  /** Optional price override, USD per 1M tokens (used for the cost estimate). */
  priceIn: z.number().min(0).max(100000).nullable().default(null),
  priceOut: z.number().min(0).max(100000).nullable().default(null),
});
export type SettingsInput = z.input<typeof settingsInput>;

type StoredSettings = {
  protocol?: Protocol;
  maxTokens?: number | null;
  baseUrl: string;
  model: string;
  apiKeyEnc: string | null;
  temperature: number | null;
  thinking: ThinkingMode;
  priceIn?: number | null;
  priceOut?: number | null;
};

export type ResolvedLlm = {
  protocol: Protocol;
  maxTokens: number | null;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number | null;
  thinking: ThinkingMode;
  priceIn?: number | null;
  priceOut?: number | null;
  source: "user" | "server";
};

/** Normalise `https://host/v1/` and bare hosts: strip trailing slashes and a trailing `/chat/completions`. */
export function normalizeBaseUrl(raw: string): string {
  let u = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = `http://${u}`;
  u = u.replace(/\/+$/, "").replace(/\/(chat\/completions|messages)$/i, "").replace(/\/+$/, "");
  return u;
}

// ---- endpoint safety ----------------------------------------------------------------------------------------

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) // CGNAT
    );
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === "::1" || l === "::") return true;
    if (l.startsWith("fe8") || l.startsWith("fe9") || l.startsWith("fea") || l.startsWith("feb")) return true; // link-local
    if (l.startsWith("fc") || l.startsWith("fd")) return true; // unique local
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);
    if (mapped) return isPrivateAddress(mapped[1]!);
  }
  return false;
}

export class EndpointError extends Error {}

/** Throws EndpointError with a user-readable reason if the URL must not be called from this server. */
export async function assertAllowedEndpoint(baseUrl: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new EndpointError("Base URL is not a valid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new EndpointError("Base URL must start with http:// or https://");
  if (u.username || u.password) throw new EndpointError("Put the API key in the API key field, not in the URL");
  if (env().LLM_ALLOW_PRIVATE_HOSTS === "true") return;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  let addrs: string[];
  try {
    addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  } catch {
    throw new EndpointError(`Cannot resolve host "${host}"`);
  }
  if (addrs.some(isPrivateAddress)) {
    throw new EndpointError("This server does not allow private/local addresses (LLM_ALLOW_PRIVATE_HOSTS=false). Use a public endpoint.");
  }
}

// ---- storage --------------------------------------------------------------------------------------------------

/** Saved API connection. One user can keep several and switch between them; `apiKeyEnc` is never sent to the browser. */
export type StoredProfile = {
  id: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  model: string;
  apiKeyEnc: string | null;
  maxTokens: number | null;
  temperature: number | null;
  thinking: ThinkingMode;
  priceIn: number | null;
  priceOut: number | null;
};

type StoredState = { profiles: StoredProfile[]; activeId: string | null; apiSetupSkipped: boolean };

/** Extends the settings form with an identity and a name so a connection can be saved and found again. */
export const profileInput = settingsInput.extend({
  id: z.string().trim().min(1).max(64).optional(),
  name: z.string().trim().max(80).optional(),
  activate: z.boolean().optional(),
});
export type ProfileInput = z.output<typeof profileInput>;

function profileId(): string {
  return `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function defaultName(baseUrl: string, model: string): string {
  try {
    const host = new URL(normalizeBaseUrl(baseUrl)).hostname.replace(/^www\./, "");
    return `${host} · ${model}`.slice(0, 80);
  } catch {
    return model.slice(0, 80);
  }
}

/** Reads the saved connections, migrating the single-endpoint layout written by older versions. */
function readState(uid: string): StoredState {
  const row = db().prepare("SELECT data FROM user_settings WHERE user_id = ?").get(uid) as { data: string } | undefined;
  if (!row) return { profiles: [], activeId: null, apiSetupSkipped: false };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(row.data) as Record<string, unknown>;
  } catch {
    return { profiles: [], activeId: null, apiSetupSkipped: false };
  }
  const raw = (parsed.profiles as StoredProfile[] | undefined) ?? [];
  if (Array.isArray(parsed.profiles)) {
    const profiles = raw.filter((p) => p && p.baseUrl && p.model).map((p) => ({ ...p, name: p.name || defaultName(p.baseUrl, p.model) }));
    const activeId = (parsed.activeId as string | undefined) ?? profiles[0]?.id ?? null;
    return {
      profiles,
      activeId: profiles.some((p) => p.id === activeId) ? activeId : (profiles[0]?.id ?? null),
      apiSetupSkipped: parsed.apiSetupSkipped === true,
    };
  }
  // old shape: one endpoint stored as a flat object
  if (typeof parsed.baseUrl === "string" && typeof parsed.model === "string") {
    const p: StoredProfile = {
      id: profileId(),
      name: defaultName(parsed.baseUrl, parsed.model),
      protocol: (parsed.protocol as Protocol) ?? "openai",
      baseUrl: parsed.baseUrl,
      model: parsed.model,
      apiKeyEnc: (parsed.apiKeyEnc as string | null) ?? null,
      maxTokens: (parsed.maxTokens as number | null) ?? null,
      temperature: (parsed.temperature as number | null) ?? null,
      thinking: (parsed.thinking as ThinkingMode) ?? "omit",
      priceIn: (parsed.priceIn as number | null) ?? null,
      priceOut: (parsed.priceOut as number | null) ?? null,
    };
    return { profiles: [p], activeId: p.id, apiSetupSkipped: false };
  }
  return { profiles: [], activeId: null, apiSetupSkipped: false };
}

function writeState(uid: string, s: StoredState): void {
  db()
    .prepare("INSERT INTO user_settings (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at")
    .run(uid, JSON.stringify(s), Date.now());
}

export function apiSetupSkipped(uid: string): boolean {
  return readState(uid).apiSetupSkipped;
}

export function setApiSetupSkipped(uid: string, skipped: boolean): void {
  const state = readState(uid);
  writeState(uid, { ...state, apiSetupSkipped: state.profiles.length ? false : skipped });
}

/** The active connection, in the shape the request builder expects. */
function readStored(uid: string): StoredProfile | null {
  const st = readState(uid);
  return st.profiles.find((p) => p.id === st.activeId) ?? st.profiles[0] ?? null;
}

/** Saves into the active connection (creating one when there is none). Kept for API compatibility. */
export function saveUserSettings(uid: string, input: z.output<typeof settingsInput>): void {
  const active = readStored(uid);
  saveProfile(uid, { ...input, ...(active ? { id: active.id } : {}), activate: true });
}

export function deleteUserSettings(uid: string): void {
  db().prepare("DELETE FROM user_settings WHERE user_id = ?").run(uid);
}

// ---- saved connections ----------------------------------------------------------------------------------------

export function listStoredProfiles(uid: string): StoredProfile[] {
  return readState(uid).profiles;
}

export function getStoredProfile(uid: string, id: string): StoredProfile | null {
  return readState(uid).profiles.find((p) => p.id === id) ?? null;
}

/** A specific saved connection, ready to be used for a request (or null when it is gone / its key is unreadable). */
export function resolveProfile(uid: string, id: string): ResolvedLlm | null {
  const p = getStoredProfile(uid, id);
  if (!p) return null;
  const key = p.apiKeyEnc ? decryptSecret(p.apiKeyEnc) : "";
  if (key === null) return null;
  return {
    protocol: p.protocol,
    maxTokens: p.maxTokens,
    baseUrl: p.baseUrl,
    apiKey: key,
    model: p.model,
    temperature: p.temperature,
    thinking: p.thinking,
    priceIn: p.priceIn,
    priceOut: p.priceOut,
    source: "user",
  };
}

/** Creates or updates a saved connection. The first one saved becomes active. */
export function saveProfile(uid: string, input: ProfileInput): StoredProfile {
  const st = readState(uid);
  const id = input.id ?? profileId();
  const prev = st.profiles.find((p) => p.id === id);
  let apiKeyEnc: string | null = prev?.apiKeyEnc ?? null;
  if (input.clearKey) apiKeyEnc = null;
  if (input.apiKey && input.apiKey.trim()) apiKeyEnc = encryptSecret(input.apiKey.trim());
  const profile: StoredProfile = {
    id,
    name: (input.name ?? "").trim() || prev?.name || defaultName(input.baseUrl, input.model),
    protocol: input.protocol,
    baseUrl: normalizeBaseUrl(input.baseUrl),
    model: input.model,
    apiKeyEnc,
    maxTokens: input.maxTokens ?? null,
    temperature: input.temperature ?? null,
    thinking: input.thinking,
    priceIn: input.priceIn ?? null,
    priceOut: input.priceOut ?? null,
  };
  st.profiles = prev ? st.profiles.map((p) => (p.id === id ? profile : p)) : [...st.profiles, profile];
  if (input.activate || !st.activeId || !st.profiles.some((p) => p.id === st.activeId)) st.activeId = id;
  st.apiSetupSkipped = false;
  writeState(uid, st);
  return profile;
}

export function setActiveProfile(uid: string, id: string): boolean {
  const st = readState(uid);
  if (!st.profiles.some((p) => p.id === id)) return false;
  writeState(uid, { ...st, activeId: id });
  return true;
}

export function deleteProfile(uid: string, id: string): void {
  const st = readState(uid);
  const profiles = st.profiles.filter((p) => p.id !== id);
  const activeId = st.activeId === id ? (profiles[0]?.id ?? null) : st.activeId;
  writeState(uid, { profiles, activeId, apiSetupSkipped: profiles.length ? st.apiSetupSkipped : false });
}

// ---- resolution -----------------------------------------------------------------------------------------------

export function serverDefault(): ResolvedLlm | null {
  // Off unless a deployment opts in: MemoSim connects the API the user adds, and remembers it.
  if (env().LLM_SERVER_DEFAULT !== "true") return null;
  const e = env();
  if (!e.LLM_BASE_URL || !e.LLM_MODEL) return null;
  return {
    protocol: e.LLM_PROTOCOL,
    maxTokens: e.LLM_MAX_TOKENS ?? null,
    baseUrl: normalizeBaseUrl(e.LLM_BASE_URL),
    apiKey: e.LLM_API_KEY ?? "",
    model: e.LLM_MODEL,
    temperature: 0.2,
    thinking: e.LLM_THINKING === "true" ? "on" : "off",
    source: "server",
  };
}

/** The LLM configuration to use for this user: their own settings if allowed and set, else the server default. */
export function resolveLlm(uid: string): ResolvedLlm | null {
  if (env().LLM_ALLOW_CUSTOM === "true") {
    const s = readStored(uid);
    if (s) {
      const key = s.apiKeyEnc ? decryptSecret(s.apiKeyEnc) : "";
      if (key !== null) {
        return { protocol: s.protocol ?? "openai", maxTokens: s.maxTokens ?? null, baseUrl: s.baseUrl, apiKey: key, model: s.model, temperature: s.temperature, thinking: s.thinking, priceIn: s.priceIn ?? null, priceOut: s.priceOut ?? null, source: "user" };
      }
      // stored key can no longer be decrypted: fall through to the server default instead of sending garbage
    }
  }
  return serverDefault();
}

export type PublicProfile = {
  id: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  keyHint: string;
  keyUnreadable: boolean;
  temperature: number | null;
  maxTokens: number | null;
  thinking: ThinkingMode;
  priceIn: number | null;
  priceOut: number | null;
};

export type PublicSettings = {
  allowCustom: boolean;
  allowPrivate: boolean;
  /** Every connection this user saved, newest last. Contains no secret except a last-4 hint. */
  profiles: PublicProfile[];
  activeId: string | null;
  active: { source: "user" | "server" | "none"; protocol: Protocol; baseUrl: string; model: string };
  /** The active connection, for clients written before saved connections existed. */
  user: Omit<PublicProfile, "id" | "name"> | null;
  server: { protocol: Protocol; baseUrl: string; model: string } | null;
};

export function publicProfile(p: StoredProfile): PublicProfile {
  let hint = "";
  let unreadable = false;
  if (p.apiKeyEnc) {
    const k = decryptSecret(p.apiKeyEnc);
    if (k === null) unreadable = true;
    else hint = keyHint(k);
  }
  return {
    id: p.id,
    name: p.name,
    protocol: p.protocol,
    baseUrl: p.baseUrl,
    model: p.model,
    hasKey: Boolean(p.apiKeyEnc) && !unreadable,
    keyHint: hint,
    keyUnreadable: unreadable,
    temperature: p.temperature,
    maxTokens: p.maxTokens,
    thinking: p.thinking,
    priceIn: p.priceIn,
    priceOut: p.priceOut,
  };
}

/** Everything the Settings dialog needs. Contains no secrets except a last-4 hint. */
export function publicSettings(uid: string): PublicSettings {
  const e = env();
  const allowCustom = e.LLM_ALLOW_CUSTOM === "true";
  const st = allowCustom ? readState(uid) : { profiles: [], activeId: null };
  const profiles = st.profiles.map(publicProfile);
  const activeProfile = profiles.find((p) => p.id === st.activeId) ?? profiles[0] ?? null;
  const active = resolveLlm(uid);
  const srv = serverDefault();
  return {
    allowCustom,
    allowPrivate: e.LLM_ALLOW_PRIVATE_HOSTS === "true",
    profiles,
    activeId: activeProfile?.id ?? null,
    active: active ? { source: active.source, protocol: active.protocol, baseUrl: active.baseUrl, model: active.model } : { source: "none", protocol: "openai", baseUrl: "", model: "" },
    user: activeProfile
      ? {
          protocol: activeProfile.protocol,
          maxTokens: activeProfile.maxTokens,
          baseUrl: activeProfile.baseUrl,
          model: activeProfile.model,
          hasKey: activeProfile.hasKey,
          keyHint: activeProfile.keyHint,
          temperature: activeProfile.temperature,
          thinking: activeProfile.thinking,
          priceIn: activeProfile.priceIn,
          priceOut: activeProfile.priceOut,
          keyUnreadable: activeProfile.keyUnreadable,
        }
      : null,
    server: srv ? { protocol: srv.protocol, baseUrl: srv.baseUrl, model: srv.model } : null,
  };
}

// ---- building requests ----------------------------------------------------------------------------------------

export function chatPayload(cfg: ResolvedLlm, messages: unknown[], tools: unknown[], stream: boolean): Record<string, unknown> {
  const p: Record<string, unknown> = { model: cfg.model, messages, stream };
  if (cfg.temperature !== null) p.temperature = cfg.temperature;
  if (cfg.thinking !== "omit") p.chat_template_kwargs = { enable_thinking: cfg.thinking === "on" };
  if (tools.length) {
    p.tools = tools;
    p.tool_choice = "auto";
  }
  return p;
}

export function authHeaders(cfg: Pick<ResolvedLlm, "apiKey">): Record<string, string> {
  return { "Content-Type": "application/json", ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) };
}
