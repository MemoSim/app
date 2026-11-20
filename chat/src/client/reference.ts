/** Browser-side access to the NetLogo reference + web search (server does the work). */
async function post<T>(body: unknown, timeoutMs = 30_000): Promise<T | null> {
  try {
    const r = await fetch("/api/reference", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export const reference = {
  lookup: (names: string[]) => post<{ results: Array<{ name: string; found: boolean; text: string }> }>({ op: "lookup", names }),
  search: (query: string, scope: string, limit: number) => post<{ text: string; count: number }>({ op: "search", query, scope, limit }),
  web: (query: string) => post<{ results: Array<{ title: string; url: string; snippet: string }>; errors: string[] }>({ op: "web", query }, 40_000),
  page: (url: string) => post<{ ok: boolean; url?: string; text?: string; error?: string }>({ op: "page", url }, 40_000),
  /** Dictionary text for a compiler/runtime error (empty string if unavailable). */
  diagnose: async (error: string, line = ""): Promise<string> => (await post<{ text: string }>({ op: "diagnose", error, line }, 8000))?.text ?? "",
};
