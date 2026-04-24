import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Read CLI version from package.json at runtime. Falls back to "0.0.0" if the file can't be read. */
export function getCliVersion(): string {
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
