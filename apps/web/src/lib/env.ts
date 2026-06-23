import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

// Reject anything that isn't a real `https://` or `http://` URL — plain
// `z.string().url()` would happily accept `ftp:`, `javascript:`, etc.
const httpsOrHttp = () =>
	z
		.string()
		.url()
		.refine((s) => /^https?:\/\//i.test(s), {
			message: "URL must start with http:// or https://",
		});

const isLocalDevAuthBypass =
	process.env.NEXT_PUBLIC_DEV_AUTH_BYPASS === "true" && process.env.NODE_ENV !== "production";

/**
 * Typed, validated environment variables.
 *
 * `createEnv` checks both `server` and `client` schemas at build/start
 * time and crashes loudly if a required var is missing — better than a
 * silent `process.env.X || "..."` fallback that masks misconfiguration.
 *
 * Public vars (`NEXT_PUBLIC_*`) need to appear in `runtimeEnv` so
 * Next.js can statically inline them at build time (the bundler
 * doesn't see destructured property accesses).
 */
export const env = createEnv({
	server: {
		// Vercel-injected; only present in production deploys.
		VERCEL_PROJECT_PRODUCTION_URL: z.string().optional(),
		VERCEL_URL: z.string().optional(),
		VERCEL_ENV: z.enum(["production", "preview", "development"]).optional(),
	},
	client: {
		// cloud-api base URL. `httpsOrHttp` rejects `ftp:` /
		// `javascript:` schemes that `z.string().url()` would let through.
		NEXT_PUBLIC_API_URL: httpsOrHttp().default("http://localhost:8000"),

		// clawdi.ai backend URL — used for cross-origin Composio + deploy
		// listing in hosted mode.
		NEXT_PUBLIC_DEPLOY_API_URL: httpsOrHttp().default("http://localhost:50021"),

		// Clerk publishable key. Local `next dev` auth bypass can run without
		// Clerk; every normal dashboard run still requires a real key.
		NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: isLocalDevAuthBypass
			? z.string().min(1).optional()
			: z.string().min(1),

		// Hosted build flag, transformed to a real boolean. `"true"`
		// enables surfaces we do not ship in OSS builds yet: v2-gated
		// channels/AI providers, hosted deployments, billing, and analytics.
		// Anything else = OSS.
		NEXT_PUBLIC_CLAWDI_HOSTED: z
			.string()
			.optional()
			.transform((v) => v === "true"),

		// Local-only browser testing bypass. When true in `next dev`, the
		// dashboard skips Clerk route protection and sends a fixed dev bearer
		// token to the local backend. Backend-side `DEV_AUTH_BYPASS=true`
		// must also be enabled, and rejects non-development environments.
		NEXT_PUBLIC_DEV_AUTH_BYPASS: z
			.string()
			.optional()
			.transform((v) => v === "true" && process.env.NODE_ENV !== "production"),
		NEXT_PUBLIC_DEV_AUTH_TOKEN: z.string().min(1).default("dev-bypass"),
		// Cosmetic identity for the bypass user so a local preview can
		// mirror the signed-in account it impersonates (DEV_AUTH_CLERK_ID
		// backend-side). Display-only — never used for authorization.
		NEXT_PUBLIC_DEV_AUTH_NAME: z.string().min(1).default("Dev User"),
		NEXT_PUBLIC_DEV_AUTH_EMAIL: z.string().min(1).default("dev@clawdi.local"),

		// Hosted-only analytics token. Optional so OSS and hosted-without-
		// analytics both validate cleanly.
		NEXT_PUBLIC_POSTHOG_TOKEN: z.string().min(1).optional(),

		// Stripe publishable key for hosted wallet top-up PaymentIntent
		// confirmation. Optional: OSS and hosted-without-card builds validate
		// cleanly; the top-up dialog degrades to an invoice-redirect path when
		// this is absent.
		NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().min(1).optional(),
	},
	runtimeEnv: {
		VERCEL_PROJECT_PRODUCTION_URL: process.env.VERCEL_PROJECT_PRODUCTION_URL,
		VERCEL_URL: process.env.VERCEL_URL,
		VERCEL_ENV: process.env.VERCEL_ENV,
		NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
		NEXT_PUBLIC_DEPLOY_API_URL: process.env.NEXT_PUBLIC_DEPLOY_API_URL,
		NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
		NEXT_PUBLIC_CLAWDI_HOSTED: process.env.NEXT_PUBLIC_CLAWDI_HOSTED,
		NEXT_PUBLIC_DEV_AUTH_BYPASS: process.env.NEXT_PUBLIC_DEV_AUTH_BYPASS,
		NEXT_PUBLIC_DEV_AUTH_TOKEN: process.env.NEXT_PUBLIC_DEV_AUTH_TOKEN,
		NEXT_PUBLIC_DEV_AUTH_NAME: process.env.NEXT_PUBLIC_DEV_AUTH_NAME,
		NEXT_PUBLIC_DEV_AUTH_EMAIL: process.env.NEXT_PUBLIC_DEV_AUTH_EMAIL,
		NEXT_PUBLIC_POSTHOG_TOKEN: process.env.NEXT_PUBLIC_POSTHOG_TOKEN,
		NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
	},
	// `bun test` preloads `test-setup.ts` to seed required vars, so
	// validation runs in tests too — this preserves the schema's
	// `transform` pipeline so consumers see real booleans / arrays.
	skipValidation: process.env.SKIP_ENV_VALIDATION === "true",
	emptyStringAsUndefined: true,
});
