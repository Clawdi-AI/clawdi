import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	transpilePackages: ["@clawdi/shared"],
	images: {
		remotePatterns: [{ hostname: "img.clerk.com" }],
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
		return [
			{ source: "/s/:id.md", destination: "/s/:id/md" },
			{ source: "/s/:id.json", destination: "/s/:id/json" },
		];
	},
};

export default nextConfig;
