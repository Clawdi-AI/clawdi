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

type RawEnv = Record<string, string | boolean | number | undefined>;

const metaEnv = ((import.meta as ImportMeta & { env?: RawEnv }).env ?? {}) as RawEnv;
const processEnv: RawEnv = typeof process === "undefined" ? {} : process.env;
const runtimeEnv: RawEnv = typeof process === "undefined" ? metaEnv : { ...metaEnv, ...processEnv };

function readRawEnvValue(rawEnv: RawEnv, key: string): string | undefined {
	const value = rawEnv[key];
	return typeof value === "string" ? value : undefined;
}

function readRawEnv(key: string): string | undefined {
	return readRawEnvValue(runtimeEnv, key);
}

export function isProductionRuntime(rawEnv: RawEnv = runtimeEnv): boolean {
	return (
		readRawEnvValue(rawEnv, "NODE_ENV") === "production" ||
		readRawEnvValue(rawEnv, "MODE") === "production"
	);
}

export function isDevAuthBypassEnabled(rawEnv: RawEnv = runtimeEnv): boolean {
	return readRawEnvValue(rawEnv, "VITE_DEV_AUTH_BYPASS") === "true" && !isProductionRuntime(rawEnv);
}

const isLocalDevAuthBypass = isDevAuthBypassEnabled();

/**
 * Typed, validated environment variables.
 *
 * `createEnv` checks both `server` and `client` schemas at build/start
 * time and crashes loudly if a required var is missing — better than a
 * silent `process.env.X || "..."` fallback that masks misconfiguration.
 */
export const env = createEnv({
	clientPrefix: "VITE_",
	client: {
		// cloud-api base URL. `httpsOrHttp` rejects `ftp:` /
		// `javascript:` schemes that `z.string().url()` would let through.
		VITE_CLAWDI_API_URL: httpsOrHttp().default("http://localhost:8000"),

		// Hosted deploy API URL — used for deploy, billing, and hosted
		// profile calls in hosted builds.
		VITE_CLAWDI_DEPLOY_API_URL: httpsOrHttp().default("http://localhost:50021"),

		// Hosted-only legacy v1 dashboard URL. The localhost default is
		// gated by `legacyHostedDashboardUrl()` so production builds only
		// expose this entry when a real URL is configured.
		VITE_CLAWDI_LEGACY_DASHBOARD_URL: httpsOrHttp().default("http://localhost:3000/dashboard"),

		// Clerk publishable key. Local auth bypass can run without
		// Clerk; every normal dashboard run still requires a real key.
		VITE_CLERK_PUBLISHABLE_KEY: isLocalDevAuthBypass
			? z.string().min(1).optional()
			: z.string().min(1),

		// Hosted build flag, transformed to a real boolean. `"true"`
		// enables surfaces we do not ship in OSS builds yet: hosted-only
		// channels/AI providers, hosted deployments, billing, and analytics.
		// Anything else = OSS.
		VITE_CLAWDI_HOSTED: z
			.string()
			.optional()
			.transform((v) => v === "true"),

		// Local-only browser testing bypass. When true in local dev, the
		// dashboard skips Clerk route protection and sends a fixed dev bearer
		// token to the local backend. Backend-side `DEV_AUTH_BYPASS=true`
		// must also be enabled, and rejects non-development environments.
		VITE_DEV_AUTH_BYPASS: z
			.string()
			.optional()
			.transform((v) => v === "true" && !isProductionRuntime()),
		VITE_DEV_AUTH_TOKEN: z.string().min(1).default("dev-bypass"),
		// Cosmetic identity for the bypass user so a local preview can
		// mirror the signed-in account it impersonates (DEV_AUTH_CLERK_ID
		// backend-side). Display-only — never used for authorization.
		VITE_DEV_AUTH_NAME: z.string().min(1).default("Dev User"),
		VITE_DEV_AUTH_EMAIL: z.string().min(1).default("dev@clawdi.local"),

		// Hosted-only analytics token. Optional so OSS and hosted-without-
		// analytics both validate cleanly.
		VITE_POSTHOG_TOKEN: z.string().min(1).optional(),

		// Stripe publishable key for hosted wallet top-up PaymentIntent
		// confirmation. Optional: OSS and hosted-without-card builds validate
		// cleanly; the top-up dialog disables card confirmation when this is absent.
		VITE_STRIPE_PUBLISHABLE_KEY: z.string().min(1).optional(),
	},
	runtimeEnv,
	// `bun test` preloads `test-setup.ts` to seed required vars, so
	// validation runs in tests too — this preserves the schema's
	// `transform` pipeline so consumers see real booleans / arrays.
	skipValidation: readRawEnv("SKIP_ENV_VALIDATION") === "true",
	emptyStringAsUndefined: true,
});
