import type { RuntimeManifest } from "./manifest-contract";
import type { RuntimePaths } from "./paths";

export function hostedRuntimeProjectionHome(
	_manifest: Pick<RuntimeManifest, "projection">,
	paths: Pick<RuntimePaths, "userHome">,
): string {
	return paths.userHome;
}
