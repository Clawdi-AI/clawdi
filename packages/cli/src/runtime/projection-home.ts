import { isAbsolute } from "node:path";
import { HOSTED_RUNTIME_BUNDLE_V2_SCHEMA_VERSION, type RuntimeManifest } from "./manifest-contract";
import type { RuntimePaths } from "./paths";

export function hostedRuntimeProjectionHome(
	manifest: Pick<RuntimeManifest, "projection">,
	paths: Pick<RuntimePaths, "userHome">,
): string {
	if (manifest.projection?.sourceBundleVersion === HOSTED_RUNTIME_BUNDLE_V2_SCHEMA_VERSION) {
		return paths.userHome;
	}
	const system = manifest.projection?.system;
	if (typeof system !== "object" || system === null || Array.isArray(system)) {
		return paths.userHome;
	}
	const home = (system as Record<string, unknown>).home;
	if (typeof home !== "string") return paths.userHome;
	const normalized = home.trim();
	return normalized && isAbsolute(normalized) ? normalized : paths.userHome;
}
