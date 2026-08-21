import { lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	canonicalManagedBundleFileMode,
	computeManagedBundleHash,
	type ManagedBundleHashEntry,
} from "./managed-bundle-hash";
import { withRuntimeUserFileAccess } from "./runtime-user-command";

const LEGACY_MARKER = ".clawdi-managed.json";
const LEGACY_MARKER_SCHEMA = "clawdi.hostedBundledSkillMarker.v1";
const LEGACY_MARKER_OWNER = "clawdi runtime init";

export interface HostedBundledSkillCatalogEntry {
	id: string;
	version: number;
	assetDirectory: string;
	digest: string;
}

const HOSTED_BUNDLED_SKILL_CATALOG = new Map<
	string,
	ReadonlyMap<number, HostedBundledSkillCatalogEntry>
>([
	[
		"clawdi",
		new Map([
			[
				1,
				Object.freeze({
					id: "clawdi",
					version: 1,
					assetDirectory: "hosted-versions/1/clawdi",
					digest: "272ec28025eb3c5227e4f7d7215327d5c070e7c4c87933e4d6df2f5bf33f9b9c",
				}),
			],
		]),
	],
]);

function collectDirectoryEntries(
	directory: string,
	prefix: string,
	options: { excludeLegacyMarker: boolean; requireCanonicalModes: boolean },
	files: ManagedBundleHashEntry[],
): void {
	const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
		left.name.localeCompare(right.name),
	);
	for (const entry of entries) {
		const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (options.excludeLegacyMarker && relativePath === LEGACY_MARKER) continue;
		const path = join(directory, entry.name);
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) {
			throw new Error(`symbolic links are not supported in managed skills: ${path}`);
		}
		if (stat.isDirectory()) {
			if (options.requireCanonicalModes && (stat.mode & 0o777) !== 0o755) {
				throw new Error(`managed skill directory mode is not canonical: ${path}`);
			}
			collectDirectoryEntries(path, relativePath, options, files);
			continue;
		}
		if (stat.isFile()) {
			const mode = stat.mode & 0o777;
			if (options.requireCanonicalModes && mode !== canonicalManagedBundleFileMode(mode)) {
				throw new Error(`managed skill file mode is not canonical: ${path}`);
			}
			files.push({ relativePath, mode, content: readFileSync(path) });
			continue;
		}
		throw new Error(`unsupported entry in managed skill: ${path}`);
	}
}

function directoryDigest(
	directory: string,
	options: { excludeLegacyMarker?: boolean; requireCanonicalModes?: boolean } = {},
): string {
	const stat = lstatSync(directory);
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		throw new Error(`managed skill path is not a directory: ${directory}`);
	}
	if (options.requireCanonicalModes && (stat.mode & 0o777) !== 0o755) {
		throw new Error(`managed skill directory mode is not canonical: ${directory}`);
	}
	const files: ManagedBundleHashEntry[] = [];
	collectDirectoryEntries(
		directory,
		"",
		{
			excludeLegacyMarker: options.excludeLegacyMarker ?? false,
			requireCanonicalModes: options.requireCanonicalModes ?? false,
		},
		files,
	);
	return computeManagedBundleHash(files);
}

export function managedSkillDirectoryDigest(directory: string): string {
	return directoryDigest(directory);
}

export function hostedBundledSkillIds(): string[] {
	return [...HOSTED_BUNDLED_SKILL_CATALOG.keys()];
}

export function resolveHostedBundledSkill(
	skillId: string,
	version: number,
): HostedBundledSkillCatalogEntry {
	const versions = HOSTED_BUNDLED_SKILL_CATALOG.get(skillId);
	if (!versions) throw new Error(`no bundled hosted skill is registered for ${skillId}`);
	const entry = versions.get(version);
	if (!entry) {
		throw new Error(`no bundled hosted skill ${skillId} version ${version} is registered`);
	}
	return entry;
}

export function assertHostedBundledSkillCatalogDigest(
	catalogEntry: HostedBundledSkillCatalogEntry,
	sourceDir: string,
): void {
	if (directoryDigest(sourceDir) !== catalogEntry.digest) {
		throw new Error(
			`bundled hosted skill catalog digest mismatch for ${catalogEntry.id} version ${catalogEntry.version}`,
		);
	}
}

function readLegacyMarker(targetDir: string): Record<string, unknown> | null {
	try {
		const path = join(targetDir, LEGACY_MARKER);
		if (!lstatSync(path).isFile()) return null;
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/**
 * One-time migration shim for pre-ledger hosted bundles. Remove only after all
 * supported hosted CLI versions have written reservation-backed receipts and
 * the oldest pre-ledger runtime image is outside the supported upgrade window.
 */
function adoptableLegacyHostedBundledSkill(
	targetDir: string,
	skillId: string,
): HostedBundledSkillCatalogEntry | null {
	const marker = readLegacyMarker(targetDir);
	if (!marker) return null;
	const current =
		marker.schema === LEGACY_MARKER_SCHEMA &&
		marker.owner === LEGACY_MARKER_OWNER &&
		marker.id === skillId &&
		typeof marker.version === "number" &&
		Number.isSafeInteger(marker.version) &&
		marker.version > 0 &&
		typeof marker.digest === "string";
	const legacy = marker.managedBy === LEGACY_MARKER_OWNER && marker.skillName === skillId;
	if (!current && !legacy) return null;
	let catalogEntry: HostedBundledSkillCatalogEntry;
	try {
		catalogEntry = resolveHostedBundledSkill(skillId, current ? (marker.version as number) : 1);
	} catch {
		return null;
	}
	if (current && marker.digest !== catalogEntry.digest) return null;
	try {
		return directoryDigest(targetDir, {
			excludeLegacyMarker: true,
			requireCanonicalModes: true,
		}) === catalogEntry.digest
			? catalogEntry
			: null;
	} catch {
		return null;
	}
}

export function claimLegacyHostedBundledSkill(input: {
	targetDir: string;
	skillId: string;
	reserve(catalogEntry: HostedBundledSkillCatalogEntry): void;
	anchorOwnership(ownershipIdentity: string): void;
}): boolean {
	const catalogEntry = withRuntimeUserFileAccess(() =>
		adoptableLegacyHostedBundledSkill(input.targetDir, input.skillId),
	);
	if (!catalogEntry) return false;

	input.reserve(catalogEntry);
	withRuntimeUserFileAccess(() => {
		if (adoptableLegacyHostedBundledSkill(input.targetDir, input.skillId) !== catalogEntry) {
			throw new Error("legacy hosted Skill identity changed during ownership claim");
		}
		rmSync(join(input.targetDir, LEGACY_MARKER));
		input.anchorOwnership(`content-sha256\0${catalogEntry.digest}`);
	});
	return true;
}
