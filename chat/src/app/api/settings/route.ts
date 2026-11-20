import { z } from "zod";
import { getUid } from "@/lib/auth";
import { env } from "@/lib/env";
import {
  assertAllowedEndpoint, deleteProfile, deleteUserSettings, EndpointError, normalizeBaseUrl, profileInput, publicSettings, saveProfile, setActiveProfile,
} from "@/lib/llm-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const uid = await getUid().catch(() => null);
  if (!uid) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json(publicSettings(uid));
}

/** Save (create or update) one connection. The first saved connection becomes the active one. */
export async function PUT(req: Request) {
  const uid = await getUid().catch(() => null);
  if (!uid) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (env().LLM_ALLOW_CUSTOM !== "true") return Response.json({ error: "Custom LLM endpoints are disabled on this server" }, { status: 403 });
  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!raw) return Response.json({ error: "invalid JSON body" }, { status: 400 });
  // Accept both { profile: {...} } and a bare form object, so older callers keep working.
  const candidate = (raw.profile as Record<string, unknown> | undefined) ?? raw;
  const parsed = profileInput.safeParse(candidate);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return Response.json({ error: msg }, { status: 400 });
  }
  try {
    await assertAllowedEndpoint(normalizeBaseUrl(parsed.data.baseUrl));
  } catch (e) {
    if (e instanceof EndpointError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
  const saved = saveProfile(uid, parsed.data);
  return Response.json({ ...publicSettings(uid), savedId: saved.id });
}

const action = z.object({
  action: z.enum(["activate", "delete"]),
  id: z.string().trim().min(1).max(64),
});

/** Switch the connection in use, or forget one. */
export async function POST(req: Request) {
  const uid = await getUid().catch(() => null);
  if (!uid) return Response.json({ error: "unauthorized" }, { status: 401 });
  const parsed = action.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "expected { action: 'activate' | 'delete', id }" }, { status: 400 });
  if (parsed.data.action === "activate") {
    if (!setActiveProfile(uid, parsed.data.id)) return Response.json({ error: "No such connection" }, { status: 404 });
  } else {
    deleteProfile(uid, parsed.data.id);
  }
  return Response.json(publicSettings(uid));
}

/** `?id=` forgets one connection; without it, every connection is removed. */
export async function DELETE(req: Request) {
  const uid = await getUid().catch(() => null);
  if (!uid) return Response.json({ error: "unauthorized" }, { status: 401 });
  const id = new URL(req.url).searchParams.get("id");
  if (id) deleteProfile(uid, id);
  else deleteUserSettings(uid);
  return Response.json(publicSettings(uid));
}
