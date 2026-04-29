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

		// Where the "Manage" link on hosted agent tiles points. Production
		// override per-environment so dev/preview can route to local
		// dashboards without a code change.
		NEXT_PUBLIC_DEPLOY_DASHBOARD_URL: httpsOrHttp().default("https://www.clawdi.ai/dashboard"),

		// Clerk publishable key — required, no sensible default.
		NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1),

		// Hosted-only build flag, transformed to a real boolean. `"true"`
		// enables clawdi.ai cross-origin surfaces (deploy listing,
		// Composio proxy, DeployTrigger sidebar). Anything else = OSS.
		NEXT_PUBLIC_CLAWDI_HOSTED: z
			.string()
			.optional()
			.transform((v) => v === "true"),
	},
	runtimeEnv: {
		VERCEL_PROJECT_PRODUCTION_URL: process.env.VERCEL_PROJECT_PRODUCTION_URL,
		VERCEL_URL: process.env.VERCEL_URL,
		VERCEL_ENV: process.env.VERCEL_ENV,
		NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
		NEXT_PUBLIC_DEPLOY_API_URL: process.env.NEXT_PUBLIC_DEPLOY_API_URL,
		NEXT_PUBLIC_DEPLOY_DASHBOARD_URL: process.env.NEXT_PUBLIC_DEPLOY_DASHBOARD_URL,
		NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
		NEXT_PUBLIC_CLAWDI_HOSTED: process.env.NEXT_PUBLIC_CLAWDI_HOSTED,
	},
	// `bun test` preloads `test-setup.ts` to seed required vars, so
	// validation runs in tests too — this preserves the schema's
	// `transform` pipeline so consumers see real booleans / arrays.
	skipValidation: process.env.SKIP_ENV_VALIDATION === "true",
	emptyStringAsUndefined: true,
});
