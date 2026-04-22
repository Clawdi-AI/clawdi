import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	transpilePackages: ["@clawdi-cloud/shared"],
	images: {
		remotePatterns: [{ hostname: "img.clerk.com" }],
	},
};

export default nextConfig;
