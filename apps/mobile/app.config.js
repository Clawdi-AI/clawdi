const { readLinkHosts, webLinkPaths } = require("./config/linking.cjs");
// Launch surfaces use the shared `--background` tokens; regenerate with `bun run icons`.
const appColors = require("./assets/app-colors.json");

function publicValue(name) {
	const value = process.env[name]?.trim();
	return value || undefined;
}

/**
 * Geist is embedded in the native binaries so text renders in the Web font from
 * the first frame. Family names match the `--font-*` tokens in global.css: iOS
 * uses each file's PostScript name (already `Geist-Regular`, ...); Android gets
 * the same names through XML font families.
 */
const FONTS = [
	["Geist-Regular", "geist/400Regular/Geist_400Regular.ttf"],
	["Geist-Medium", "geist/500Medium/Geist_500Medium.ttf"],
	["Geist-SemiBold", "geist/600SemiBold/Geist_600SemiBold.ttf"],
	["Geist-Bold", "geist/700Bold/Geist_700Bold.ttf"],
	["GeistMono-Regular", "geist-mono/400Regular/GeistMono_400Regular.ttf"],
	["GeistMono-Medium", "geist-mono/500Medium/GeistMono_500Medium.ttf"],
].map(([fontFamily, file]) => ({
	fontFamily,
	path: `./node_modules/@expo-google-fonts/${file}`,
}));

function fontPluginOptions() {
	return {
		ios: { fonts: FONTS.map((font) => font.path) },
		android: {
			fonts: FONTS.map(({ fontFamily, path }) => ({
				fontFamily,
				fontDefinitions: [{ path, weight: 400 }],
			})),
		},
	};
}

module.exports = ({ config }) => {
	const linkHosts = readLinkHosts(publicValue("EXPO_PUBLIC_CLAWDI_LINK_HOSTS"));
	// Build-time identifiers are owner-selected; never infer a production app identity.
	const bundleIdentifier = publicValue("CLAWDI_IOS_BUNDLE_IDENTIFIER");
	const packageName = publicValue("CLAWDI_ANDROID_PACKAGE");
	const ios = {
		...config.ios,
		...(bundleIdentifier ? { bundleIdentifier } : {}),
	};
	const android = {
		...config.android,
		adaptiveIcon: {
			foregroundImage: "./assets/brand-mark.png",
			monochromeImage: "./assets/brand-mark-monochrome.png",
			backgroundColor: appColors.light,
		},
		...(packageName ? { package: packageName } : {}),
	};
	return {
		...config,
		name: "Clawdi",
		slug: "clawdi",
		scheme: "clawdi",
		version: "0.1.0",
		orientation: "portrait",
		icon: "./assets/icon.png",
		userInterfaceStyle: "automatic",
		platforms: ["ios", "android"],
		experiments: {
			typedRoutes: true,
		},
		plugins: [
			"expo-router",
			"expo-secure-store",
			["expo-font", fontPluginOptions()],
			[
				"expo-splash-screen",
				{
					image: "./assets/brand-mark.png",
					imageWidth: 200,
					backgroundColor: appColors.light,
					dark: { backgroundColor: appColors.dark },
				},
			],
			"expo-apple-authentication",
		],
		...(Object.keys(ios).length ? { ios } : {}),
		...(Object.keys(android).length ? { android } : {}),
		...(linkHosts.length
			? {
					ios: {
						...ios,
						associatedDomains: [
							...new Set([
								...(config.ios?.associatedDomains ?? []),
								...linkHosts.map((host) => `applinks:${host}`),
							]),
						],
					},
					android: {
						...android,
						intentFilters: [
							...(config.android?.intentFilters ?? []),
							...linkHosts.map((host) => ({
								action: "VIEW",
								autoVerify: true,
								category: ["BROWSABLE", "DEFAULT"],
								data: webLinkPaths.map((path) => ({ scheme: "https", host, ...path })),
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
				revenueCatAppleKey: publicValue("EXPO_PUBLIC_REVENUECAT_APPLE_KEY"),
				revenueCatGoogleKey: publicValue("EXPO_PUBLIC_REVENUECAT_GOOGLE_KEY"),
				clerkPublishableKey: publicValue("EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY"),
				clerkOauthProviders: publicValue("EXPO_PUBLIC_CLERK_OAUTH_PROVIDERS"),
				linkHosts: publicValue("EXPO_PUBLIC_CLAWDI_LINK_HOSTS"),
			},
		},
	};
};
