import { z } from "zod";
import { deleteProject, getProject, MAX_STATE_BYTES, saveProject, stateSchema } from "@/lib/repo";
import { getUid } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };
const ID = /^[0-9a-f-]{36}$/;

const putBody = z.object({
  baseRev: z.number().int().min(0),
  state: stateSchema,
  title: z.string().max(120).optional(),
});

export async function GET(_req: Request, { params }: Ctx) {
  const uid = await getUid().catch(() => null);
  if (!uid) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const p = ID.test(id) ? getProject(uid, id) : null;
  return p ? Response.json(p) : Response.json({ error: "not found" }, { status: 404 });
}

export async function PUT(req: Request, { params }: Ctx) {
  const uid = await getUid().catch(() => null);
  if (!uid) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!ID.test(id)) return Response.json({ error: "not found" }, { status: 404 });
  const raw = await req.text();
  if (raw.length > MAX_STATE_BYTES) return Response.json({ error: "project too large" }, { status: 413 });
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const parsed = putBody.safeParse(json);
  if (!parsed.success) return Response.json({ error: parsed.error.message.slice(0, 300) }, { status: 400 });
  const r = saveProject(uid, id, parsed.data.baseRev, parsed.data.state, parsed.data.title);
  if (r.ok) return Response.json({ rev: r.rev });
  if (r.reason === "notfound") console.warn(`[projects] PUT for unknown project ${id} by user ${uid.slice(0, 8)}`);
  return Response.json({ error: r.reason }, { status: r.reason === "conflict" ? 409 : 404 });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const uid = await getUid().catch(() => null);
  if (!uid) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  return ID.test(id) && deleteProject(uid, id) ? Response.json({ ok: true }) : Response.json({ error: "not found" }, { status: 404 });
}
