import type { ExpoConfig, ConfigContext } from "expo/config";

function publicValue(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value || undefined;
}

export default ({ config }: ConfigContext): ExpoConfig => ({
	...config,
	name: "Clawdi",
	slug: "clawdi",
	scheme: "clawdi",
	version: "0.1.0",
	orientation: "portrait",
	userInterfaceStyle: "automatic",
	platforms: ["ios", "android"],
	plugins: ["expo-router", "expo-secure-store"],
	extra: {
		...config.extra,
		clawdi: {
			cloudApiUrl: publicValue("EXPO_PUBLIC_CLAWDI_API_URL"),
			hostedApiUrl: publicValue("EXPO_PUBLIC_CLAWDI_HOSTED_API_URL"),
			clerkPublishableKey: publicValue("EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY"),
		},
	},
});
