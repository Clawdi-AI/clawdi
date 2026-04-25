import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	transpilePackages: ["@clawdi/shared"],
	images: {
		remotePatterns: [{ hostname: "img.clerk.com" }],
	},
};

export default nextConfig;
