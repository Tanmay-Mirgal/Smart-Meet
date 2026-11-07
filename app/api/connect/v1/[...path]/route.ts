import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const CONVEX_SITE_URL = "https://gregarious-seal-751.convex.site";

async function proxy(
  req: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  const subpath = (path ?? []).join("/");
  const url = new URL(req.url);
  const targetUrl = `${CONVEX_SITE_URL}/connect/v1/${subpath}${url.search}`;

  const headers = new Headers(req.headers);
  headers.delete("host");

  const init: RequestInit = {
    method: req.method,
    headers,
    redirect: "manual",
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.arrayBuffer();
  }

  try {
    const upstreamRes = await fetch(targetUrl, init);
    const resHeaders = new Headers(upstreamRes.headers);

    return new NextResponse(upstreamRes.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: resHeaders,
    });
  } catch (err: any) {
    console.error("Convex proxy error:", err);
    return NextResponse.json(
      {
        error: {
          code: "upstream_error",
          message: `Failed to proxy to Convex: ${err.message}`,
          retryable: true,
        },
      },
      { status: 502 },
    );
  }
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const HEAD = proxy;
export const OPTIONS = proxy;
