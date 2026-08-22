import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { computeManagedBundleHash, type ManagedBundleHashEntry } from "./managed-bundle-hash";

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
	files: ManagedBundleHashEntry[],
): void {
	const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
		left.name.localeCompare(right.name),
	);
	for (const entry of entries) {
		const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
		const path = join(directory, entry.name);
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) {
			throw new Error(`symbolic links are not supported in managed skills: ${path}`);
		}
		if (stat.isDirectory()) {
			collectDirectoryEntries(path, relativePath, files);
			continue;
		}
		if (stat.isFile()) {
			const mode = stat.mode & 0o777;
			files.push({ relativePath, mode, content: readFileSync(path) });
			continue;
		}
		throw new Error(`unsupported entry in managed skill: ${path}`);
	}
}

function directoryDigest(directory: string): string {
	const stat = lstatSync(directory);
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		throw new Error(`managed skill path is not a directory: ${directory}`);
	}
	const files: ManagedBundleHashEntry[] = [];
	collectDirectoryEntries(directory, "", files);
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
