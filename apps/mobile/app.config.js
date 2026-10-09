const { readLinkHosts, webLinkPaths } = require("@clawdi/shared/linking");
const { parsePublishableKey } = require("@clerk/shared/keys");
// Brand red from the artwork and the shared `--background` tokens; regenerate with `bun run icons`.
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
	const clerkPublishableKey = publicValue("EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY");
	// Clerk native passkeys need the Frontend API host, which the publishable key encodes.
	const clerkFrontendApi = parsePublishableKey(clerkPublishableKey)?.frontendApi;
	const associatedDomains = [
		...new Set([
			...(config.ios?.associatedDomains ?? []),
			...linkHosts.map((host) => `applinks:${host}`),
			...(clerkFrontendApi ? [`webcredentials:${clerkFrontendApi}`] : []),
		]),
	];
	const projectId = publicValue("EAS_PROJECT_ID");
	const ios = {
		...config.ios,
		bundleIdentifier: "ai.clawdi.app",
		supportsTablet: false,
		config: { ...config.ios?.config, usesNonExemptEncryption: false },
		privacyManifests: {
			NSPrivacyTracking: false,
			// Union of the RN/Expo manifests, Sentry Cocoa 8.58.0 and RevenueCat iOS 5.92.0.
			NSPrivacyAccessedAPITypes: [
				{
					NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryFileTimestamp",
					NSPrivacyAccessedAPITypeReasons: ["C617.1", "0A2A.1", "3B52.1"],
				},
				{
					NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategorySystemBootTime",
					NSPrivacyAccessedAPITypeReasons: ["35F9.1"],
				},
				{
					NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryDiskSpace",
					NSPrivacyAccessedAPITypeReasons: ["E174.1", "85F4.1"],
				},
				{
					NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryUserDefaults",
					NSPrivacyAccessedAPITypeReasons: ["CA92.1"],
				},
			],
			NSPrivacyCollectedDataTypes: [
				["EmailAddress", true],
				["Name", true],
				["UserID", true],
				["PurchaseHistory", true],
				["OtherUserContent", true],
				["PhotosorVideos", true],
				["CrashData", false],
				["PerformanceData", false],
				["OtherDiagnosticData", false],
			].map(([type, linked]) => ({
				NSPrivacyCollectedDataType: `NSPrivacyCollectedDataType${type}`,
				NSPrivacyCollectedDataTypeLinked: linked,
				NSPrivacyCollectedDataTypeTracking: false,
				NSPrivacyCollectedDataTypePurposes: ["NSPrivacyCollectedDataTypePurposeAppFunctionality"],
			})),
		},
	};
	const android = {
		...config.android,
		package: "ai.clawdi.app",
		allowBackup: false,
		adaptiveIcon: {
			foregroundImage: "./assets/adaptive-icon.png",
			monochromeImage: "./assets/adaptive-icon-monochrome.png",
			backgroundColor: appColors.brand,
		},
		// App files use the system picker or app-private cache, never legacy shared storage.
		blockedPermissions: [
			...new Set([
				...(config.android?.blockedPermissions ?? []),
				"android.permission.SYSTEM_ALERT_WINDOW",
				"android.permission.READ_EXTERNAL_STORAGE",
				"android.permission.WRITE_EXTERNAL_STORAGE",
				"android.permission.USE_FINGERPRINT",
				"android.permission.VIBRATE",
			]),
		],
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
		runtimeVersion: { policy: "fingerprint" },
		...(projectId ? { updates: { url: `https://u.expo.dev/${projectId}` } } : {}),
		plugins: [
			"expo-router",
			"expo-secure-store",
			["expo-font", fontPluginOptions()],
			[
				"expo-splash-screen",
				{
					image: "./assets/splash-icon.png",
					// The rounded square's corners reach 92dp from center, inside Android 12's 96dp icon mask.
					imageWidth: 150,
					backgroundColor: appColors.light,
					dark: { backgroundColor: appColors.dark },
				},
			],
			// Keep native hooks stable for Build/Update; upload scripts read org/project/token from env.
			"@sentry/react-native/expo",
			["@clerk/expo", { theme: "./clerk-theme.generated.json" }],
		],
		ios: associatedDomains.length ? { ...ios, associatedDomains } : ios,
		android,
		...(linkHosts.length
			? {
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
			...(projectId ? { eas: { projectId } } : {}),
			clawdi: {
				sentryDsn: publicValue("EXPO_PUBLIC_SENTRY_DSN"),
				cloudApiUrl: publicValue("EXPO_PUBLIC_CLAWDI_API_URL"),
				computeApiUrl: publicValue("EXPO_PUBLIC_CLAWDI_COMPUTE_API_URL"),
				revenueCatAppleKey: publicValue("EXPO_PUBLIC_REVENUECAT_APPLE_KEY"),
				revenueCatGoogleKey: publicValue("EXPO_PUBLIC_REVENUECAT_GOOGLE_KEY"),
				revenueCatCustomerCenterEnabled:
					publicValue("EXPO_PUBLIC_REVENUECAT_CUSTOMER_CENTER_ENABLED") === "1",
				clerkPublishableKey,
				linkHosts: publicValue("EXPO_PUBLIC_CLAWDI_LINK_HOSTS"),
			},
		},
	};
};
