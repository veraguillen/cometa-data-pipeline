/**
 * proxy.ts — Next.js 16 Edge Proxy.
 *
 * Rules:
 *   /login          → always pass through (login page handles its own session check)
 *   /analyst/*      + no ANA-* cookie → /login?next=pathname
 *   /founder/*      + no FND-* cookie → /login?next=pathname
 *   /               + ANA-* cookie    → /analyst/dashboard  (shortcut)
 *   /               + FND-* cookie    → /founder/onboarding (shortcut)
 *
 * NOTE: /login is NOT protected so users can always reach it to re-authenticate.
 * The login page itself calls validateSession() and redirects if already logged in.
 */

import { NextRequest, NextResponse } from "next/server";

const COOKIE_NAME = "cometa_user_id";

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const userId = request.cookies.get(COOKIE_NAME)?.value ?? "";

  const isAna = userId.startsWith("ANA-");
  const isFnd = userId.startsWith("FND-");

  // Root shortcut for authenticated users
  if (pathname === "/") {
    if (isAna) return NextResponse.redirect(new URL("/analyst/dashboard", request.url));
    if (isFnd) return NextResponse.redirect(new URL("/founder/onboarding", request.url));
  }

  // Protect /analyst/* — must have ANA- cookie
  if (pathname.startsWith("/analyst/") && !isAna) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Protect /founder/* — must have FND- cookie
  if (pathname.startsWith("/founder/") && !isFnd) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/analyst/:path*", "/founder/:path*"],
};
