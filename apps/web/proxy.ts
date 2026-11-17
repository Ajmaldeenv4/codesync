// Optimistic route guard: bounces signed-out requests early. Every page and route handler
// still checks the session itself (see lib/session.ts).
import { auth } from "@/auth";

export const proxy = auth((req) => {
  if (req.auth?.user) return;
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const signInUrl = new URL("/", req.nextUrl.origin);
  signInUrl.searchParams.set("callbackUrl", req.nextUrl.pathname);
  return Response.redirect(signInUrl);
});

export const config = {
  matcher: ["/room/:path*", "/api/rooms/:path*"],
};
