const { readLinkHosts } = require("./config/linking.cjs");

function publicValue(name) {
	const value = process.env[name]?.trim();
	return value || undefined;
}

module.exports = ({ config }) => {
	const linkHosts = readLinkHosts(publicValue("EXPO_PUBLIC_CLAWDI_LINK_HOSTS"));
	return {
		...config,
		name: "Clawdi",
		slug: "clawdi",
		scheme: "clawdi",
		version: "0.1.0",
		orientation: "portrait",
		userInterfaceStyle: "automatic",
		platforms: ["ios", "android"],
		newArchEnabled: true,
		experiments: {
			typedRoutes: true,
		},
		plugins: ["expo-router", "expo-secure-store"],
		...(linkHosts.length
			? {
					ios: {
						...config.ios,
						associatedDomains: [
							...new Set([
								...(config.ios?.associatedDomains ?? []),
								...linkHosts.map((host) => `applinks:${host}`),
							]),
						],
					},
					android: {
						...config.android,
						intentFilters: [
							...(config.android?.intentFilters ?? []),
							...linkHosts.map((host) => ({
								action: "VIEW",
								autoVerify: true,
								category: ["BROWSABLE", "DEFAULT"],
								data: [
									{ scheme: "https", host, pathPrefix: "/s/" },
									{ scheme: "https", host, path: "/vault-request" },
								],
							})),
						],
					},
				}
			: {}),
		extra: {
			...config.extra,
			clawdi: {
				cloudApiUrl: publicValue("EXPO_PUBLIC_CLAWDI_API_URL"),
				computeApiUrl: publicValue("EXPO_PUBLIC_CLAWDI_COMPUTE_API_URL"),
				clerkPublishableKey: publicValue("EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY"),
				clerkOauthProviders: publicValue("EXPO_PUBLIC_CLERK_OAUTH_PROVIDERS"),
				linkHosts: publicValue("EXPO_PUBLIC_CLAWDI_LINK_HOSTS"),
			},
		},
	};
};
