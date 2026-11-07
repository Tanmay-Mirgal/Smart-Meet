import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const CONVEX_SITE_URL = (
  process.env.NEXT_PUBLIC_CONVEX_SITE_URL?.trim() ||
  "https://gregarious-seal-751.convex.site"
).replace(/\/+$/, "");

export async function GET() {
  try {
    const res = await fetch(`${CONVEX_SITE_URL}/connect/v1/manifest`, {
      cache: "no-store",
    });
    const data = await res.json();
    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json(
      {
        error: {
          code: "manifest_error",
          message: `Failed to fetch manifest: ${err.message}`,
        },
      },
      { status: 502 },
    );
  }
}
