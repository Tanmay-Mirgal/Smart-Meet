import Razorpay from "razorpay";
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

// Pro plan price in paise (₹849 = 84900 paise)
export const PRO_PLAN_AMOUNT_PAISE = 84900;
export const PRO_PLAN_AMOUNT_USD = 10;

export function getRazorpayInstance() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret || keyId.includes("XXXX")) {
    throw new Error("MISSING_KEYS");
  }

  return new Razorpay({ key_id: keyId, key_secret: keySecret });
}

export async function POST(request: Request) {
  const clerkAuth = await auth();
  if (!clerkAuth.userId) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  const payload = (await request.json().catch(() => null)) as { orgId?: string, couponCode?: string } | null;
  const orgId = payload?.orgId?.trim();

  if (!orgId) {
    return NextResponse.json({ error: "Organization ID is required" }, { status: 400 });
  }

  // NOTE: clerkAuth.orgId may be null on some session token configurations
  // even when the user is inside an org — so we check membership instead of
  // doing a strict equality check, which would wrongly block valid users.
  // The Convex mutation in the verify route does its own assertOrgAccess check.
  // We still block if orgId is explicitly a *different* org (not just missing).
  if (clerkAuth.orgId && clerkAuth.orgId !== orgId) {
    return NextResponse.json(
      { error: "Switch to the target organization before upgrading." },
      { status: 403 },
    );
  }

  try {
    const razorpay = getRazorpayInstance();

    // Check for secret coupon code
    let amount = PRO_PLAN_AMOUNT_PAISE;
    if (payload?.couponCode === "TANMAY1010") {
      amount = 900; // ~ $0.11
    }

    const order = await razorpay.orders.create({
      amount: amount,
      currency: "INR",
      receipt: `sm_pro_${orgId.slice(-8)}_${Date.now()}`,
      notes: {
        orgId,
        userId: clerkAuth.userId,
        plan: "pro",
        product: "Meetup Pro",
      },
    });

    return NextResponse.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    // Friendly error for missing keys (most common in production)
    if (message === "MISSING_KEYS") {
      console.error("[razorpay/create-order] RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set in environment variables");
      return NextResponse.json(
        { error: "Payment is not configured yet. Please contact support." },
        { status: 503 },
      );
    }

    console.error("[razorpay/create-order]", err);
    return NextResponse.json(
      { error: "Failed to create payment order. " + message },
      { status: 500 },
    );
  }
}
