import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

declare const CLAWDI_CLI_VERSION: string | undefined;

/**
 * Resolve the CLI version.
 *
 * Packaged Node/Bun installs can read package.json from disk. Single-file
 * binaries cannot, so release builds inject CLAWDI_CLI_VERSION at build time.
 */
export function getCliVersion(): string {
	const compiledVersion = typeof CLAWDI_CLI_VERSION === "string" ? CLAWDI_CLI_VERSION.trim() : "";
	if (compiledVersion) return compiledVersion;

	try {
		// import.meta.url → .../src/lib/version.ts at dev time, .../dist/index.js at build time
		const here = dirname(fileURLToPath(import.meta.url));
		// Try common relative locations: dev = ../../package.json, built bundle = ../package.json
		for (const rel of ["../../package.json", "../package.json"]) {
			try {
				const raw = readFileSync(join(here, rel), "utf-8");
				const pkg = JSON.parse(raw) as { version?: string };
				if (pkg.version) return pkg.version;
			} catch {
				// try next
			}
		}
	} catch {
		// fall through
	}
	return "0.0.0";
}
