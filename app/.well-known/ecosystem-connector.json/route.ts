import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const CONVEX_SITE_URL = "https://gregarious-seal-751.convex.site";

export async function GET() {
  const targetUrl = `${CONVEX_SITE_URL}/connect/v1/manifest`;
  try {
    const res = await fetch(targetUrl, {
      cache: "no-store",
    });
    const text = await res.text();
    try {
      const data = JSON.parse(text);
      return NextResponse.json(data);
    } catch {
      return NextResponse.json(
        {
          error: {
            code: "json_parse_error",
            message: `Target returned non-JSON: ${text.slice(0, 200)}`,
            targetUrl,
            status: res.status,
          },
        },
        { status: 502 },
      );
    }
  } catch (err: any) {
    return NextResponse.json(
      {
        error: {
          code: "manifest_error",
          message: `Failed to fetch manifest from ${targetUrl}: ${err.message}`,
        },
      },
      { status: 502 },
    );
  }
}
