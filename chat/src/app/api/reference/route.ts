import { z } from "zod";
import { getUid } from "@/lib/auth";
import { diagnoseReference, formatHits, lookup, referenceDb, search } from "@/lib/reference";
import { fetchPage, webSearch } from "@/lib/websearch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("lookup"), names: z.array(z.string().min(1).max(80)).min(1).max(8) }),
  z.object({ op: z.literal("search"), query: z.string().min(2).max(300), scope: z.enum(["all", "dictionary", "extensions", "guide", "models"]).default("all"), limit: z.number().int().min(1).max(8).default(4) }),
  z.object({ op: z.literal("web"), query: z.string().min(2).max(200) }),
  z.object({ op: z.literal("page"), url: z.string().url().max(500) }),
  z.object({ op: z.literal("diagnose"), error: z.string().min(1).max(3000), line: z.string().max(400).default("") }),
]);

// light per-user rate limit for the network-touching operations
const hits = new Map<string, number[]>();
function limited(uid: string, perMinute: number): boolean {
  const now = Date.now();
  const arr = (hits.get(uid) ?? []).filter((t) => now - t < 60_000);
  if (arr.length >= perMinute) { hits.set(uid, arr); return true; }
  arr.push(now);
  hits.set(uid, arr);
  if (hits.size > 5000) hits.delete(hits.keys().next().value as string);
  return false;
}

export async function GET() {
  const db = referenceDb();
  const meta = db ? Object.fromEntries((db.prepare("SELECT k, v FROM meta").all() as Array<{ k: string; v: string }>).map((r) => [r.k, r.v])) : null;
  return Response.json({ available: Boolean(db), ...(meta ?? {}) });
}

export async function POST(req: Request) {
  const uid = await getUid().catch(() => null);
  if (!uid) return Response.json({ error: "unauthorized" }, { status: 401 });
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, { status: 400 });
  const b = parsed.data;

  if ((b.op === "web" || b.op === "page") && limited(uid, 20)) return Response.json({ error: "too many web lookups; wait a minute" }, { status: 429 });

  switch (b.op) {
    case "lookup":
      return Response.json({ results: lookup(b.names) });
    case "search": {
      const hitsFound = search(b.query, b.scope, b.limit);
      return Response.json({ text: formatHits(hitsFound), count: hitsFound.length });
    }
    case "diagnose":
      return Response.json({ text: diagnoseReference(b.error, b.line) });
    case "web": {
      const r = await webSearch(b.query);
      return Response.json(r);
    }
    case "page":
      return Response.json(await fetchPage(b.url));
  }
}
