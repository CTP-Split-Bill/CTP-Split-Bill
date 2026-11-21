// Gate app pages with the database-backed Auth.js session. APIs authenticate
// in their route/domain path so signed-out calls keep the standard JSON 401.
// Signed-out visitors go to /login; signed-in visitors never see /login.
import { auth } from "@project/auth";
import { NextResponse } from "next/server";
import { GUEST_PAGE_HEADER, isGuestPage, pageRedirect } from "./app/lib/page-access";

export default auth((request) => {
  const target = pageRedirect(request.nextUrl.pathname, request.nextUrl.search, Boolean(request.auth));
  if (target) return NextResponse.redirect(new URL(target, request.url));
  // Always overwrite the browser's value: this flag only controls the shell,
  // never authorization. Guest pages must not query or render an account.
  const headers = new Headers(request.headers);
  headers.set(GUEST_PAGE_HEADER, isGuestPage(request.nextUrl.pathname) ? "1" : "0");
  return NextResponse.next({ request: { headers } });
});

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
  runtime: "nodejs",
};
