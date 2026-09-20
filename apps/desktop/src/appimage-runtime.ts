import {
	accessSync,
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { cp, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

const RUNTIME_MARKER = "desktop-runtime.json";
const DESKTOP_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const RUNTIME_FILES = [
	"clawdi",
	"skills/clawdi/SKILL.md",
	"skills/hosted-versions/1/clawdi/SKILL.md",
	"egress-addon/clawdi_egress_addon.py",
];

/** An AppImage mount disappears on exit. Only its immutable, application-owned
 * runtime copy may be registered with systemd. Rename publishes a complete copy. */
export async function activateAppImageRuntime(
	source: string,
	userData: string,
	version: string,
): Promise<string> {
	if (!DESKTOP_VERSION.test(version)) {
		throw new Error("Invalid Desktop version.");
	}
	const root = join(userData, "runtimes");
	const target = join(root, version);
	if (existsSync(join(target, RUNTIME_MARKER))) {
		validateRuntime(target, version);
		return realpathSync(target);
	}
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const staging = mkdtempSync(join(root, `${version}.staging-`));
	try {
		await cp(source, staging, { recursive: true });
		writeFileSync(join(staging, RUNTIME_MARKER), JSON.stringify({ version }));
		validateRuntime(staging, version);
		try {
			await rename(staging, target);
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!("code" in error) ||
				!["EEXIST", "ENOTEMPTY"].includes(String(error.code))
			)
				throw error;
			// Another process may have published this immutable version first.
			// Reuse only a complete winner; never replace an active runtime in place.
			validateRuntime(target, version);
		}
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
	return realpathSync(target);
}

/** Remove only complete, marker-owned runtimes after the active version has
 * successfully replaced the systemd unit. Invalid or unrelated directories
 * are left untouched. */
export async function pruneAppImageRuntimes(
	userData: string,
	activeVersion: string,
	protectedVersions: ReadonlySet<string> = new Set(),
): Promise<void> {
	if (!DESKTOP_VERSION.test(activeVersion)) return;
	const root = join(userData, "runtimes");
	if (!existsSync(root)) return;
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (
			!entry.isDirectory() ||
			entry.name === activeVersion ||
			protectedVersions.has(entry.name) ||
			!DESKTOP_VERSION.test(entry.name)
		) {
			continue;
		}
		const directory = join(root, entry.name);
		try {
			const marker: unknown = JSON.parse(await readFile(join(directory, RUNTIME_MARKER), "utf8"));
			if (
				marker &&
				typeof marker === "object" &&
				"version" in marker &&
				marker.version === entry.name
			) {
				await rm(directory, { recursive: true, force: true });
			}
		} catch {
			// A damaged or foreign directory is not ours to remove automatically.
		}
	}
}

function validateRuntime(directory: string, version: string): void {
	try {
		const identity: unknown = JSON.parse(readFileSync(join(directory, RUNTIME_MARKER), "utf8"));
		if (
			!identity ||
			typeof identity !== "object" ||
			!("version" in identity) ||
			identity.version !== version
		)
			throw new Error("Invalid runtime marker.");
		for (const resource of RUNTIME_FILES) {
			const stat = lstatSync(join(directory, resource));
			if (!stat.isFile() || stat.size === 0)
				throw new Error(`Invalid runtime resource: ${resource}`);
		}
		accessSync(join(directory, "clawdi"), constants.X_OK);
	} catch (cause) {
		throw new Error(
			"Desktop runtime is incomplete or not executable. Disable Sync and remove the damaged runtime before retrying.",
			{ cause },
		);
	}
}
