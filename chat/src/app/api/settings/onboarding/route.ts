import { z } from "zod";
import { getUid } from "@/lib/auth";
import { setApiSetupSkipped } from "@/lib/llm-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const body = z.object({ skipped: z.boolean() });

export async function PUT(req: Request) {
  const uid = await getUid().catch(() => null);
  if (!uid) return Response.json({ error: "unauthorized" }, { status: 401 });
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "expected { skipped: boolean }" }, { status: 400 });
  setApiSetupSkipped(uid, parsed.data.skipped);
  return Response.json({ ok: true });
}
