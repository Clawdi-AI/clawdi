import type { NextConfig } from "next";

const isHostedBuild = process.env.NEXT_PUBLIC_CLAWDI_HOSTED === "true";
const posthogProxyPath = "/_cdi/px";
const allowedDevOrigins = (process.env.NEXT_ALLOWED_DEV_ORIGINS ?? "")
	.split(",")
	.map((origin) => origin.trim())
	.filter(Boolean);

const nextConfig: NextConfig = {
	transpilePackages: ["@clawdi/shared"],
	...(allowedDevOrigins.length > 0 ? { allowedDevOrigins } : {}),
	devIndicators: false,
	// PostHog uses trailing slashes in capture endpoints (e.g. `/e/`).
	// Redirecting these breaks payload delivery.
	skipTrailingSlashRedirect: isHostedBuild,
	images: {
		remotePatterns: [
			{ hostname: "img.clerk.com" },
			// Full-color brand/app icons for channels (and any future entity icons).
			{ hostname: "assets.clawdi.ai" },
			// Colored brand-logo fallback for AI providers without a CDN icon.
			{ hostname: "cdn.simpleicons.org" },
		],
	},
	// Share URLs use a file-extension UX (`/s/{id}.md`, `/s/{id}.json`)
	// rather than `/s/{id}?format=md`. The extension is what makes
	// `curl https://cloud.clawdi.ai/s/abc.md` "just work" without flags, and
	// what makes an agent's WebFetch / Read tool pick the right code path
	// on the response. Next.js dynamic segments don't support dots in path
	// syntax, so we rewrite `.md` / `.json` suffixes to an internal
	// `[format]` segment that a single route handler covers. The browser
	// still sees `/s/abc.md` in the URL bar — the rewrite is internal.
	async rewrites() {
		const rewrites = [
			{ source: "/s/:id.md", destination: "/s/:id/md" },
			{ source: "/s/:id.json", destination: "/s/:id/json" },
		];

		if (isHostedBuild) {
			rewrites.push(
				{
					source: `${posthogProxyPath}/static/:path*`,
					destination: "https://us-assets.i.posthog.com/static/:path*",
				},
				{
					source: `${posthogProxyPath}/:path*`,
					destination: "https://us.i.posthog.com/:path*",
				},
			);
		}

		return rewrites;
	},
	// Billing surfaces moved under routed Settings (`/settings/billing/*`).
	// Keep the old top-level paths working for any saved deep links. Hosted
	// builds only — these routes never resolve to content in OSS. Temporary
	// (307) redirects so the mapping can still evolve without sticky browser
	// caches.
	async redirects() {
		if (!isHostedBuild) return [];
		return [
			{ source: "/wallet", destination: "/settings/billing/wallet", permanent: false },
			{ source: "/subscription", destination: "/settings/billing/plan", permanent: false },
			// Pricing folded into the Plan tab's upgrade flow — old links land there.
			{ source: "/pricing", destination: "/settings/billing/plan", permanent: false },
			{
				source: "/settings/billing/pricing",
				destination: "/settings/billing/plan",
				permanent: false,
			},
			{ source: "/rewards", destination: "/settings/billing/rewards", permanent: false },
		];
	},
};

export default nextConfig;
