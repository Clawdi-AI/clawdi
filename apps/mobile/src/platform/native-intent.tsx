import { randomUUID } from "expo-crypto";
import { getCustomTabsSupportingBrowsersAsync, openBrowserAsync } from "expo-web-browser";
import { Platform } from "react-native";
import { loadMobileRuntimeConfig } from "@/lib/config/runtime";
import { incomingVaultLink, routeMobileIncomingLink } from "@/platform/incoming-link";

/** Custom Tabs pinned to the browser package, so a link host never resolves back to this app. */
export async function openBrowserLink(url: string) {
	if (Platform.OS === "android") {
		const { preferredBrowserPackage } = await getCustomTabsSupportingBrowsersAsync();
		if (!preferredBrowserPackage) throw new Error("No Custom Tabs browser available");
		// Pin the browser package so Android cannot resolve this URL back to our app.
		return openBrowserAsync(url, { browserPackage: preferredBrowserPackage });
	}
	const result = await openBrowserAsync(url);
	if (result.type === "locked") throw new Error("Browser is already open");
	return result;
}

export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }) {
	// Read-only presentation stories are reachable only in development builds.
	if (__DEV__ && /^clawdi:\/\/\/?dev\/account\?panel=[a-z-]+$/.test(path)) {
		return `/dev/account?panel=${path.split("?panel=")[1]}`;
	}
	const config = loadMobileRuntimeConfig();
	return routeMobileIncomingLink(
		path,
		config.ok ? (config.value.linkHosts ?? []) : [],
		(link) => incomingVaultLink.stage(randomUUID(), link),
		openBrowserLink,
		initial,
	);
}
