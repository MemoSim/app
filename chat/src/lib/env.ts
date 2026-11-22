import { z } from "zod";

const schema = z.object({
  // Server-wide default LLM. Optional: users can bring their own endpoint in Settings.
  LLM_BASE_URL: z.string().url().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().optional(),
  LLM_PROTOCOL: z.enum(["openai", "anthropic"]).default("openai"),
  LLM_MAX_TOKENS: z.coerce.number().int().min(16).optional(),
  LLM_THINKING: z.enum(["true", "false"]).default("false"),
  /**
   * Serve the env-configured LLM as a fallback for users who have not connected their own API.
   * Off by default: MemoSim asks the user for an endpoint and remembers it instead of silently using a built-in one.
   */
  LLM_SERVER_DEFAULT: z.enum(["true", "false"]).default("false"),
  /** Let users point the app at their own OpenAI-compatible endpoint (Settings). */
  LLM_ALLOW_CUSTOM: z.enum(["true", "false"]).default("true"),
  /** Allow custom endpoints on private/loopback addresses (Ollama, vLLM on LAN). Set false on a public multi-user server. */
  LLM_ALLOW_PRIVATE_HOSTS: z.enum(["true", "false"]).default("true"),
  NLW_VERSION: z.string().default("2.15.3"),
  LLM_MAX_CONCURRENT: z.coerce.number().int().min(1).default(4),
  /** How long to wait for the LLM to START answering. Gateways queue, so this must exceed a busy queue, not a slow model. */
  LLM_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(240_000),
  /** Once tokens are flowing, abort only when the stream stalls this long (never on total duration). */
  LLM_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120_000),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;
export function env(): Env {
  if (!cached) cached = schema.parse(process.env);
  return cached;
}
