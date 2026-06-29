import { createEnv } from "@t3-oss/env-core";
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
	readRawEnv("NEXT_PUBLIC_DEV_AUTH_BYPASS") === "true" && readMode() !== "production";

type RawEnv = Record<string, string | boolean | number | undefined>;

function readImportMetaEnv(): RawEnv {
	return ((import.meta as ImportMeta & { env?: RawEnv }).env ?? {}) as RawEnv;
}

function readProcessEnv(): RawEnv {
	return typeof process === "undefined" ? {} : process.env;
}

function readRawEnv(key: string): string | undefined {
	const value = readImportMetaEnv()[key] ?? readProcessEnv()[key];
	return typeof value === "string" ? value : undefined;
}

function readMode(): string {
	return readRawEnv("MODE") ?? readRawEnv("NODE_ENV") ?? "development";
}

function runtimeEnv(): RawEnv {
	const vite = readImportMetaEnv();
	const node = readProcessEnv();
	return {
		...node,
		...vite,
		VERCEL_PROJECT_PRODUCTION_URL:
			vite.VERCEL_PROJECT_PRODUCTION_URL ?? node.VERCEL_PROJECT_PRODUCTION_URL,
		VERCEL_URL: vite.VERCEL_URL ?? node.VERCEL_URL,
		VERCEL_ENV: vite.VERCEL_ENV ?? node.VERCEL_ENV,
		NEXT_PUBLIC_API_URL: vite.NEXT_PUBLIC_API_URL ?? node.NEXT_PUBLIC_API_URL,
		NEXT_PUBLIC_DEPLOY_API_URL: vite.NEXT_PUBLIC_DEPLOY_API_URL ?? node.NEXT_PUBLIC_DEPLOY_API_URL,
		NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
			vite.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? node.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
		NEXT_PUBLIC_CLAWDI_HOSTED: vite.NEXT_PUBLIC_CLAWDI_HOSTED ?? node.NEXT_PUBLIC_CLAWDI_HOSTED,
		NEXT_PUBLIC_DEV_AUTH_BYPASS:
			vite.NEXT_PUBLIC_DEV_AUTH_BYPASS ?? node.NEXT_PUBLIC_DEV_AUTH_BYPASS,
		NEXT_PUBLIC_DEV_AUTH_TOKEN: vite.NEXT_PUBLIC_DEV_AUTH_TOKEN ?? node.NEXT_PUBLIC_DEV_AUTH_TOKEN,
		NEXT_PUBLIC_DEV_AUTH_NAME: vite.NEXT_PUBLIC_DEV_AUTH_NAME ?? node.NEXT_PUBLIC_DEV_AUTH_NAME,
		NEXT_PUBLIC_DEV_AUTH_EMAIL: vite.NEXT_PUBLIC_DEV_AUTH_EMAIL ?? node.NEXT_PUBLIC_DEV_AUTH_EMAIL,
		NEXT_PUBLIC_POSTHOG_TOKEN: vite.NEXT_PUBLIC_POSTHOG_TOKEN ?? node.NEXT_PUBLIC_POSTHOG_TOKEN,
		NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY:
			vite.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? node.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
		SKIP_ENV_VALIDATION: vite.SKIP_ENV_VALIDATION ?? node.SKIP_ENV_VALIDATION,
	};
}

/**
 * Typed, validated environment variables.
 *
 * `createEnv` checks both `server` and `client` schemas at build/start
 * time and crashes loudly if a required var is missing — better than a
 * silent `process.env.X || "..."` fallback that masks misconfiguration.
 *
 * Public vars (`NEXT_PUBLIC_*`) need to appear in `runtimeEnv` so Vite and
 * the server runtime validate the same shape.
 */
export const env = createEnv({
	clientPrefix: "NEXT_PUBLIC_",
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

		// Hosted deploy API URL — used for deploy, billing, and hosted
		// profile calls in hosted builds.
		NEXT_PUBLIC_DEPLOY_API_URL: httpsOrHttp().default("http://localhost:50021"),

		// Clerk publishable key. Local auth bypass can run without
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

		// Local-only browser testing bypass. When true in local dev, the
		// dashboard skips Clerk route protection and sends a fixed dev bearer
		// token to the local backend. Backend-side `DEV_AUTH_BYPASS=true`
		// must also be enabled, and rejects non-development environments.
		NEXT_PUBLIC_DEV_AUTH_BYPASS: z
			.string()
			.optional()
			.transform((v) => v === "true" && readMode() !== "production"),
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
		// cleanly; the top-up dialog disables card confirmation when this is absent.
		NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().min(1).optional(),
	},
	runtimeEnv: runtimeEnv(),
	// `bun test` preloads `test-setup.ts` to seed required vars, so
	// validation runs in tests too — this preserves the schema's
	// `transform` pipeline so consumers see real booleans / arrays.
	skipValidation: readRawEnv("SKIP_ENV_VALIDATION") === "true",
	emptyStringAsUndefined: true,
});
