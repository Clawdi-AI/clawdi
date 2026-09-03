import { collectRegularFileTree, sha256TreeDigest } from "../lib/file-tree";

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
					digest: "d99dfc8c6745a0f2a5d01845c0404b9c65a79634ce7bba704a350ffe7e097a0a",
				}),
			],
		]),
	],
]);

export const MANAGED_SKILL_TREE_LIMITS = Object.freeze({
	entries: 1_024,
	files: 1_024,
	fileBytes: 16 * 1024 * 1024,
	totalBytes: 32 * 1024 * 1024,
});

function directoryDigest(directory: string): string {
	return sha256TreeDigest(
		collectRegularFileTree(directory, {
			limits: MANAGED_SKILL_TREE_LIMITS,
			resourceLabel: "managed Skill tree",
		}),
	).slice("sha256-tree-v1:".length);
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
