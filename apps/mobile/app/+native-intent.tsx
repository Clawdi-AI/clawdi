import { randomUUID } from "expo-crypto";
import { loadMobileRuntimeConfig } from "../src/config/runtime";
import { incomingVaultLink, mobileLinkDestination } from "../src/platform/incoming-link";

export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
	const config = loadMobileRuntimeConfig();
	return mobileLinkDestination(path, config.ok ? (config.value.linkHosts ?? []) : [], (link) =>
		incomingVaultLink.stage(randomUUID(), link),
	);
}
