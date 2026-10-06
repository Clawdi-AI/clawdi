import { randomUUID } from "expo-crypto";
import { loadMobileRuntimeConfig } from "@/lib/config/runtime";
import { incomingVaultLink, mobileLinkDestination } from "@/platform/incoming-link";

export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
	// Read-only presentation stories are reachable only in development builds.
	if (__DEV__ && /^clawdi:\/\/\/?dev\/account\?panel=[a-z-]+$/.test(path)) {
		return `/dev/account?panel=${path.split("?panel=")[1]}`;
	}
	const config = loadMobileRuntimeConfig();
	return mobileLinkDestination(path, config.ok ? (config.value.linkHosts ?? []) : [], (link) =>
		incomingVaultLink.stage(randomUUID(), link),
	);
}
