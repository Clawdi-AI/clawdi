import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { RuntimePaths } from "./paths";

export function hermesWarmMarker(paths: RuntimePaths): string {
	return join(paths.runRoot, "hermes-warmed");
}

/** Warm-up is explicit and root-owned; ordinary tenants retain their ordering. */
export function hermesWasWarmed(paths: RuntimePaths): boolean {
	try {
		const stat = lstatSync(hermesWarmMarker(paths));
		return stat.isFile() && stat.uid === 0 && (stat.mode & 0o077) === 0;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}
