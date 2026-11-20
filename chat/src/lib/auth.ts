import { headers } from "next/headers";
import { db } from "./db";

const SINGLE_USER_ID = "00000000-0000-4000-8000-000000000001";
let adopted = false;

/**
 * Single-user (desktop) mode: earlier versions created a random user per launch, so settings and models may be stored under
 * old ids. Once per process, move them to the fixed id (the newest settings row wins; projects are all re-owned).
 */
export function adoptLegacyData(uid: string): void {
  if (adopted) return;
  adopted = true;
  try {
    const d = db();
    const has = d.prepare("SELECT 1 FROM user_settings WHERE user_id = ?").get(uid);
    if (!has) {
      const latest = d.prepare("SELECT data, updated_at FROM user_settings ORDER BY updated_at DESC LIMIT 1").get() as { data: string; updated_at: number } | undefined;
      if (latest) d.prepare("INSERT INTO user_settings (user_id, data, updated_at) VALUES (?, ?, ?)").run(uid, latest.data, latest.updated_at);
    }
    d.prepare("UPDATE projects SET user_id = ? WHERE user_id != ?").run(uid, uid);
    d.prepare("UPDATE usage SET user_id = ? WHERE user_id != ?").run(uid, uid);
  } catch {
    /* never block a request because of the migration */
  }
}

/** Current user id (set by middleware). Throws if missing, which route handlers map to 401. */
export async function getUid(): Promise<string> {
  const uid = (await headers()).get("x-uid");
  if (!uid) throw new Error("no user identity");
  if (process.env.NLCHAT_SINGLE_USER === "true" && uid === SINGLE_USER_ID) adoptLegacyData(uid);
  return uid;
}
