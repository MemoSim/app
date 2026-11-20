import { getUid } from "@/lib/auth";
import { perModel, totals } from "@/lib/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const uid = await getUid().catch(() => null);
  if (!uid) return Response.json({ error: "unauthorized" }, { status: 401 });
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Response.json({ all: totals(uid), today: totals(uid, today.getTime()), models: perModel(uid) });
}
