import { NextResponse, type NextRequest } from "next/server";

const COOKIE = "nlchat_uid";
/** Desktop app: one local user. The embedded WebView does not keep cookies between launches, so a cookie identity would
 *  create a new (empty) user every start and lose settings and models. The desktop server sets NLCHAT_SINGLE_USER=true. */
export const SINGLE_USER_ID = "00000000-0000-4000-8000-000000000001";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Anonymous per-browser identity. Issues a random httpOnly cookie and forwards it to server code
 * as `x-uid` (always overwritten, so clients cannot spoof it). Swap this for real auth later;
 * everything downstream only depends on `getUid()`.
 */
export function middleware(req: NextRequest) {
  if (process.env.NLCHAT_SINGLE_USER === "true") {
    const h = new Headers(req.headers);
    h.set("x-uid", SINGLE_USER_ID);
    return NextResponse.next({ request: { headers: h } });
  }
  const existing = req.cookies.get(COOKIE)?.value;
  const fresh = !existing || !UUID.test(existing);
  const uid = fresh ? crypto.randomUUID() : existing;
  const headers = new Headers(req.headers);
  headers.set("x-uid", uid);
  const res = NextResponse.next({ request: { headers } });
  if (fresh) {
    res.cookies.set(COOKIE, uid, {
      httpOnly: true,
      sameSite: "lax",
      secure: req.nextUrl.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https",
      maxAge: 60 * 60 * 24 * 365,
      path: "/",
    });
  }
  return res;
}

export const config = { matcher: ["/((?!_next/|nlw/|favicon.ico).*)"] };
