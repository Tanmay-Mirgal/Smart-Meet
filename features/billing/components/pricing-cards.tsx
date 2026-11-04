"use client";

import { useState, useCallback } from "react";
import { CheckCircle2, Sparkles, Zap, Lock, Crown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { FREE_FEATURES, PRO_FEATURES, PRO_PRICE } from "@/lib/plans";
import { BRAND_COLORS, SITE_NAME } from "@/lib/site";

// ── Types ────────────────────────────────────────────────────────────────────

interface RazorpayOptions {
  key: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  order_id: string;
  handler: (response: {
    razorpay_order_id: string;
    razorpay_payment_id: string;
    razorpay_signature: string;
  }) => void;
  prefill?: { name?: string; email?: string };
  theme?: { color?: string };
  modal?: { ondismiss?: () => void };
}

declare global {
  interface Window {
    Razorpay: new (options: RazorpayOptions) => { open(): void };
  }
}

function loadRazorpayScript(): Promise<boolean> {
  return new Promise((resolve) => {
    if (window.Razorpay) return resolve(true);
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

// ── Props ────────────────────────────────────────────────────────────────────

interface PricingCardsProps {
  orgId: string;
  currentPlanKey: "starter" | "pro" | "custom";
  onUpgradeSuccess: () => void;
  userName?: string;
  userEmail?: string;
}

// ── Component ────────────────────────────────────────────────────────────────

export function PricingCards({
  orgId,
  currentPlanKey,
  onUpgradeSuccess,
  userName,
  userEmail,
}: PricingCardsProps) {
  const [isLoading, setIsLoading] = useState(false);
  const isPro = currentPlanKey === "pro" || currentPlanKey === "custom";

  const handleUpgrade = useCallback(async (couponCode?: string) => {
    setIsLoading(true);

    try {
      // 1. Load Razorpay script
      const scriptLoaded = await loadRazorpayScript();
      if (!scriptLoaded) {
        toast.error("Could not load payment SDK. Check your internet connection.");
        setIsLoading(false);
        return;
      }

      // 2. Create order
      const orderRes = await fetch("/api/billing/razorpay/create-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId, couponCode }),
      });
      const orderData = await orderRes.json() as {
        orderId?: string;
        amount?: number;
        currency?: string;
        keyId?: string;
        error?: string;
      };

      if (!orderRes.ok || !orderData.orderId) {
        toast.error(orderData.error ?? "Failed to create payment order");
        setIsLoading(false);
        return;
      }

      // 3. Open Razorpay checkout
      const options: RazorpayOptions = {
        key: orderData.keyId!,
        amount: orderData.amount!,
        currency: orderData.currency ?? "INR",
        name: SITE_NAME,
        description: "Pro Plan — Unlimited meetings & AI features",
        order_id: orderData.orderId,
        prefill: { name: userName, email: userEmail },
        theme: { color: BRAND_COLORS.primary },
        modal: {
          ondismiss: () => {
            setIsLoading(false);
            toast.info("Payment cancelled");
          },
        },
        handler: async (response) => {
          // 4. Verify payment server-side
          try {
            const verifyRes = await fetch("/api/billing/razorpay/verify", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                razorpay_order_id: response.razorpay_order_id,
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_signature: response.razorpay_signature,
                orgId,
              }),
            });
            const verifyData = await verifyRes.json() as { ok?: boolean; error?: string; paymentId?: string };

            if (verifyData.ok) {
              toast.success("🎉 Upgraded to Pro! All features are now unlocked.");
              onUpgradeSuccess();
            } else {
              toast.error(
                verifyData.error ?? "Payment received but plan sync failed. Contact support.",
              );
            }
          } catch {
            toast.error("Verification failed. Contact support with your payment ID.");
          } finally {
            setIsLoading(false);
          }
        },
      };

      new window.Razorpay(options).open();
    } catch {
      toast.error("Something went wrong. Please try again.");
      setIsLoading(false);
    }
  }, [orgId, userName, userEmail, onUpgradeSuccess]);

  return (
    <div className="grid gap-5 sm:grid-cols-2">
      {/* ── Free Plan ── */}
      <div className="relative flex flex-col rounded-2xl border border-border/60 bg-card/60 p-6 backdrop-blur-sm">
        <div className="mb-5">
          <div className="flex items-center gap-2 mb-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted">
              <Zap className="h-4 w-4 text-muted-foreground" />
            </div>
            <span className="text-sm font-semibold text-foreground">Free</span>
            {!isPro && (
              <Badge variant="secondary" className="ml-auto text-xs">
                Current plan
              </Badge>
            )}
          </div>

          <div className="mb-1">
            <span className="text-4xl font-black text-foreground">$0</span>
            <span className="ml-1 text-sm text-muted-foreground">/ ₹0 per month</span>
          </div>
          <p className="text-xs text-muted-foreground">Perfect for getting started</p>
        </div>

        <ul className="mb-6 flex-1 space-y-2.5">
          {FREE_FEATURES.map((f) => (
            <li key={f} className="flex items-center gap-2 text-sm text-muted-foreground">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
              {f}
            </li>
          ))}
        </ul>

        <Button variant="outline" className="w-full" disabled>
          {isPro ? "Downgraded plan" : "Current plan"}
        </Button>
      </div>

      {/* ── Pro Plan ── */}
      <div className="relative flex flex-col rounded-2xl border border-primary/30 bg-gradient-to-b from-primary/[0.07] to-card p-6 shadow-[0_0_30px_-8px] shadow-primary/20 backdrop-blur-sm">
        {/* Glow */}
        <div className="pointer-events-none absolute -inset-px rounded-2xl bg-gradient-to-b from-primary/10 to-transparent" />

        {/* Popular badge */}
        <div className="absolute -top-3 left-1/2 -translate-x-1/2">
          <div className="flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary px-3 py-0.5 text-[11px] font-bold text-primary-foreground shadow-md">
            <Sparkles className="h-3 w-3" />
            MOST POPULAR
          </div>
        </div>

        <div className="relative mb-5">
          <div className="flex items-center gap-2 mb-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
              <Crown className="h-4 w-4 text-brand" />
            </div>
            <span className="text-sm font-semibold text-foreground">Pro</span>
            {isPro && (
              <Badge className="ml-auto text-xs bg-primary/10 text-brand border border-primary/20">
                Current plan ✓
              </Badge>
            )}
          </div>

          <div className="mb-1 flex items-end gap-2">
            <span className="text-4xl font-black text-foreground">${PRO_PRICE.usd}</span>
            <div className="mb-1 text-sm text-muted-foreground leading-tight">
              <div>/ month</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold text-brand">₹{PRO_PRICE.inr}</span>
            <span className="text-xs text-muted-foreground">/ month (INR)</span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">Everything in Free, plus</p>
        </div>

        <ul className="relative mb-6 flex-1 space-y-2.5">
          {PRO_FEATURES.map((f) => (
            <li key={f} className="flex items-center gap-2 text-sm text-foreground/90">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-brand" />
              {f}
            </li>
          ))}
        </ul>

        {isPro ? (
          <div className="relative flex items-center justify-center gap-2 rounded-xl bg-primary/10 border border-primary/20 px-4 py-3 text-sm font-semibold text-brand">
            <CheckCircle2 className="h-4 w-4" />
            You&apos;re on Pro — all features unlocked!
          </div>
        ) : (
          <div className="space-y-3 mt-auto">
            <input
              type="text"
              placeholder="Coupon Code"
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              id="coupon-code-input"
            />
            <Button
              className="relative w-full gap-2 h-11 text-sm font-semibold rounded-xl bg-primary text-primary-foreground shadow-[0_1px_2px_0_rgb(0_0_0/0.3),0_4px_16px_-4px] shadow-primary/25 hover:shadow-[0_4px_24px_-4px] hover:shadow-primary/40 hover:-translate-y-0.5 transition-all duration-200 disabled:opacity-60 disabled:pointer-events-none"
              onClick={() => {
                const couponCode = (document.getElementById('coupon-code-input') as HTMLInputElement)?.value;
                handleUpgrade(couponCode);
              }}
              disabled={isLoading}
            >
              {isLoading ? (
                <>
                  <span className="h-4 w-4 rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground animate-spin" />
                  Processing…
                </>
              ) : (
                <>
                  <Lock className="h-4 w-4" />
                  Upgrade to Pro — ₹{PRO_PRICE.inr}/mo
                </>
              )}
            </Button>
          </div>
        )}

        <p className="relative mt-2.5 text-center text-[11px] text-muted-foreground/50">
          Secured by Razorpay · One-time payment · Instant activation
        </p>
      </div>
    </div>
  );
}
