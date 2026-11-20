import { createProject, listProjects } from "@/lib/repo";
import { getUid } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const uid = await getUid().catch(() => null);
  if (!uid) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json({ projects: listProjects(uid) });
}

export async function POST() {
  const uid = await getUid().catch(() => null);
  if (!uid) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json(createProject(uid), { status: 201 });
}
