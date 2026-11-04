/** Shared Clerk styling so sign-in, sign-up and onboarding match the Meetup UI. */

const authElements = {
  // Card shell
  rootBox: "w-full",
  card: "w-full overflow-hidden !rounded-3xl border border-border bg-card/80 shadow-2xl shadow-black/30 backdrop-blur-xl",

  // Header
  headerTitle: "font-display text-xl font-bold tracking-tight text-foreground",
  headerSubtitle: "text-sm text-muted-foreground",
  logoBox: "hidden",

  // Social buttons
  socialButtonsBlockButton:
    "!rounded-xl border border-border bg-background/60 text-sm font-medium text-foreground transition-colors hover:bg-muted/60",
  socialButtonsBlockButtonText: "font-medium text-foreground",
  dividerLine: "bg-border",
  dividerText: "text-xs text-muted-foreground/70",

  // Form fields
  formFieldLabel: "text-sm font-medium text-foreground/80",
  formFieldInput:
    "!rounded-xl border border-border bg-background/60 text-sm text-foreground transition-colors placeholder:text-muted-foreground/50 focus:border-primary/60 focus:ring-2 focus:ring-primary/20",
  formFieldInputShowPasswordButton: "text-muted-foreground hover:text-foreground",
  otpCodeFieldInput:
    "!rounded-lg border border-border bg-background/60 text-base font-semibold text-foreground focus:border-primary/60 focus:ring-2 focus:ring-primary/20",

  // Primary button
  formButtonPrimary:
    "!rounded-xl bg-primary text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/30 transition-all hover:-translate-y-px hover:bg-primary/90 active:bg-primary/80",

  // Footer
  footerActionText: "text-sm text-muted-foreground",
  footerActionLink: "font-semibold text-brand underline-offset-2 hover:underline",
  footer: "border-t border-border/60 bg-muted/20",

  // Alerts / errors
  formFieldErrorText: "text-xs text-destructive",
  alertText: "text-sm",
  alert: "!rounded-xl border-destructive/30 bg-destructive/10",

  // Identity preview
  identityPreviewText: "text-sm text-foreground",
  identityPreviewEditButton: "text-sm text-brand hover:underline",
} as const;

export const authAppearance = { elements: authElements } as const;

export const createOrganizationAppearance = {
  elements: {
    rootBox: "flex w-full justify-center shadow-none",
    card: "w-full border-none bg-transparent shadow-none",
    headerTitle: "hidden",
    headerSubtitle: "hidden",
    formButtonPrimary:
      "h-auto w-full !rounded-xl bg-primary py-3 font-semibold text-primary-foreground shadow-lg shadow-primary/30 hover:bg-primary/90",
    formFieldInput:
      "h-11 !rounded-xl border-transparent bg-secondary focus:ring-2 focus:ring-primary/30",
    formFieldLabel: "mb-1.5 text-sm font-semibold text-foreground",
    logoImage: "hidden",
    footerActionLink: "font-medium text-brand hover:text-brand/80",
  },
} as const;
