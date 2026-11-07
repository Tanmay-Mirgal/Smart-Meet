import { AuthConfig } from "convex/server";

export default {
    providers: [
        {
            domain: "https://clerk.tanmaymirgal.dev",
            applicationID: "convex",
        },
        {
            domain: "https://alive-liger-48.clerk.accounts.dev",
            applicationID: "convex",
        },
    ],
} satisfies AuthConfig;

