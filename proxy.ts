import { NextResponse } from "next/server";
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isProtectedRoute = createRouteMatcher([
  "/dashboard(.*)",
  "/meeting(.*)",
  "/tasks(.*)",
  "/minutes-of-meetings(.*)",
  "/integrations(.*)",
  "/billing(.*)",
  "/insights(.*)",
  "/onboarding(.*)",
  // Ecosystem connector consent screen (needs the signed-in Clerk user).
  "/connect(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect();
    return;
  }

  // Signed-in visitors skip the marketing page. Doing this here (instead of in the
  // page) keeps the landing page itself static, so it can be served from the CDN.
  if (req.nextUrl.pathname === "/") {
    const { userId } = await auth();
    if (userId) {
      return NextResponse.redirect(new URL("/dashboard", req.url));
    }
  }
});

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params.
    // The connector's server-to-server API (/api/connect/*) and discovery document
    // (/.well-known/*) are also skipped: they authenticate with their own bearer
    // tokens, so Clerk must never inspect those requests.
    "/((?!_next|\\.well-known|api/connect/|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes (except the connector API, see above)
    "/(api(?!/connect/)|trpc)(.*)",
  ],
};
