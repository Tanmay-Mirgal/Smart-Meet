import type { Metadata, Viewport } from "next";
import { Inter, Manrope } from "next/font/google";
import "./globals.css";
import { cn } from "@/lib/utils";
import { ClerkProvider } from "@clerk/nextjs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { dark } from "@clerk/ui/themes";
import {
  SITE_NAME,
  SITE_DESCRIPTION,
  SITE_KEYWORDS,
  websiteJsonLd,
  organizationJsonLd,
  softwareAppJsonLd,
} from "@/lib/metadata";
import { BRAND_COLORS, SITE_TAGLINE } from "@/lib/site";
import { getPublicAppUrl } from "@/lib/public-app-url";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const manrope = Manrope({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

const siteUrl = getPublicAppUrl();

export const viewport: Viewport = {
  themeColor: BRAND_COLORS.ink,
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  applicationName: SITE_NAME,
  title: {
    template: `%s | ${SITE_NAME}`,
    default: `${SITE_NAME} — ${SITE_TAGLINE}`,
  },
  description: SITE_DESCRIPTION,
  keywords: SITE_KEYWORDS,
  authors: [{ name: SITE_NAME, url: siteUrl }],
  creator: SITE_NAME,
  publisher: SITE_NAME,
  category: "Technology",
  // Favicons live next to this file: app/favicon.ico, app/icon.svg, app/apple-icon.png
  manifest: "/manifest.json",
  alternates: {
    canonical: siteUrl,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  openGraph: {
    title: `${SITE_NAME} — ${SITE_TAGLINE}`,
    description: SITE_DESCRIPTION,
    siteName: SITE_NAME,
    type: "website",
    url: siteUrl,
    locale: "en_IN",
    images: [
      {
        url: `${siteUrl}/og-image.png`,
        width: 1200,
        height: 630,
        alt: `${SITE_NAME} — ${SITE_TAGLINE}`,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: `${SITE_NAME} — ${SITE_TAGLINE}`,
    description: SITE_DESCRIPTION,
    images: [`${siteUrl}/og-image.png`],
  },
  verification: {
    // Add your Google Search Console, Bing, Yandex tokens here when you have them
    // google: "YOUR_GOOGLE_SITE_VERIFICATION_TOKEN",
    // yandex: "YOUR_YANDEX_VERIFICATION_TOKEN",
    // bing: "YOUR_BING_VERIFICATION_TOKEN",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider
      appearance={{
        theme: dark,
        variables: {
          colorPrimary: BRAND_COLORS.primary,
          colorBackground: "#15131f",
          borderRadius: "0.75rem",
        },
      }}
    >
      <TooltipProvider>
        <html
          lang="en"
          className={cn(
            "h-full dark antialiased font-sans",
            inter.variable,
            manrope.variable,
          )}
          suppressHydrationWarning
        >
          <head>
            {/* ── JSON-LD Structured Data ── */}
            <script
              type="application/ld+json"
              dangerouslySetInnerHTML={{ __html: JSON.stringify(websiteJsonLd()) }}
            />
            <script
              type="application/ld+json"
              dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd()) }}
            />
            <script
              type="application/ld+json"
              dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareAppJsonLd()) }}
            />
          </head>
          <body className="min-h-full flex flex-col" suppressHydrationWarning>
            {children}
          </body>
        </html>
      </TooltipProvider>
    </ClerkProvider>
  );
}
