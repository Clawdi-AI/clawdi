function publicValue(name) {
	const value = process.env[name]?.trim();
	return value || undefined;
}

module.exports = ({ config }) => ({
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
	extra: {
		...config.extra,
		clawdi: {
			cloudApiUrl: publicValue("EXPO_PUBLIC_CLAWDI_API_URL"),
			computeApiUrl: publicValue("EXPO_PUBLIC_CLAWDI_COMPUTE_API_URL"),
			clerkPublishableKey: publicValue("EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY"),
		},
	},
});
