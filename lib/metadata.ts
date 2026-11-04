import type { Metadata } from "next";
import { getPublicAppUrl } from "@/lib/public-app-url";
import { PRO_FEATURES, PRO_PRICE } from "@/lib/plans";
import {
  SITE_DESCRIPTION,
  SITE_KEYWORDS,
  SITE_NAME,
} from "@/lib/site";

export { SITE_DESCRIPTION, SITE_KEYWORDS, SITE_NAME };

function buildTitle(title: string) {
  return `${title} | ${SITE_NAME}`;
}

const INDEXABLE_ROBOTS = {
  index: true,
  follow: true,
  googleBot: {
    index: true,
    follow: true,
    "max-video-preview": -1,
    "max-image-preview": "large",
    "max-snippet": -1,
  },
} as const;

const PRIVATE_ROBOTS = {
  index: false,
  follow: false,
  googleBot: { index: false, follow: false },
} as const;

interface CreateMetadataOptions {
  title: string;
  description: string;
  /** Path relative to root, e.g. "/dashboard". Used for canonical URL. */
  path?: string;
  keywords?: string[];
  /** Whether search engines should index this page. Defaults to true. */
  index?: boolean;
  /** OG image path (relative). Defaults to /og-image.png */
  ogImage?: string;
  /** Use the title verbatim instead of appending " | Meetup" (home page). */
  absoluteTitle?: boolean;
}

export function createMetadata({
  title,
  description,
  path = "/",
  keywords = [],
  index = true,
  ogImage = "/og-image.png",
  absoluteTitle = false,
}: CreateMetadataOptions): Metadata {
  const siteUrl = getPublicAppUrl();
  const canonicalUrl = path === "/" ? siteUrl : `${siteUrl}${path}`;
  const fullOgImage = `${siteUrl}${ogImage}`;
  const socialTitle = absoluteTitle ? title : buildTitle(title);

  return {
    // The root layout's `title.template` appends the site name for us.
    title: absoluteTitle ? { absolute: title } : title,
    description,
    keywords: [...SITE_KEYWORDS, ...keywords],
    alternates: { canonical: canonicalUrl },
    robots: index ? INDEXABLE_ROBOTS : PRIVATE_ROBOTS,
    openGraph: {
      title: socialTitle,
      description,
      siteName: SITE_NAME,
      type: "website",
      url: canonicalUrl,
      locale: "en_IN",
      images: [
        {
          url: fullOgImage,
          width: 1200,
          height: 630,
          alt: socialTitle,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: socialTitle,
      description,
      images: [fullOgImage],
    },
  };
}

// Legacy compat — keeps old call signature working
export function createMeetingMetadata(title: string, description: string): Metadata {
  return createMetadata({ title, description, index: false });
}

// ── JSON-LD structured data helpers ──────────────────────────────────────────

export function websiteJsonLd() {
  const siteUrl = getPublicAppUrl();
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": `${siteUrl}/#website`,
    name: SITE_NAME,
    url: siteUrl,
    description: SITE_DESCRIPTION,
    inLanguage: "en",
    publisher: { "@id": `${siteUrl}/#organization` },
  };
}

export function organizationJsonLd() {
  const siteUrl = getPublicAppUrl();
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": `${siteUrl}/#organization`,
    name: SITE_NAME,
    url: siteUrl,
    logo: {
      "@type": "ImageObject",
      url: `${siteUrl}/logo.png`,
      width: 512,
      height: 512,
    },
    description: SITE_DESCRIPTION,
  };
}

export function softwareAppJsonLd() {
  const siteUrl = getPublicAppUrl();
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "@id": `${siteUrl}/#software`,
    name: SITE_NAME,
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    url: siteUrl,
    image: `${siteUrl}/og-image.png`,
    description: SITE_DESCRIPTION,
    offers: [
      {
        "@type": "Offer",
        name: "Free",
        price: "0",
        priceCurrency: "INR",
      },
      {
        "@type": "Offer",
        name: "Pro",
        price: String(PRO_PRICE.inr),
        priceCurrency: "INR",
        description: PRO_FEATURES.join(", "),
      },
    ],
    featureList: [
      "Live video meeting rooms",
      "Real-time transcription in Hindi, Marathi and English",
      "AI-generated meeting summaries",
      "Action item tracking",
      "Minutes of meeting documents",
      "Google Calendar and Notion integrations",
    ],
  };
}

export function faqJsonLd(items: ReadonlyArray<{ question: string; answer: string }>) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: { "@type": "Answer", text: item.answer },
    })),
  };
}

export function breadcrumbJsonLd(
  items: { name: string; url: string }[],
) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  };
}
