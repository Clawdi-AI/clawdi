import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	canonicalManagedBundleFileMode,
	computeManagedBundleHash,
	type ManagedBundleHashEntry,
} from "./managed-bundle-hash";
import {
	activateManagedSkillDirectory,
	type ManagedSkillDirectoryActivationOptions,
} from "./managed-skill-reservation";

const HOSTED_BUNDLED_SKILL_MARKER = ".clawdi-managed.json";
const HOSTED_BUNDLED_SKILL_MARKER_SCHEMA = "clawdi.hostedBundledSkillMarker.v1";
const HOSTED_BUNDLED_SKILL_OWNER = "clawdi runtime init";
const HOSTED_BUNDLED_SKILL_DIRECTORY_MODE = 0o755;

interface HostedBundledSkillMarker {
	schema: typeof HOSTED_BUNDLED_SKILL_MARKER_SCHEMA;
	owner: typeof HOSTED_BUNDLED_SKILL_OWNER;
	id: string;
	version: number;
	digest: string;
}

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

export interface ReconcileHostedBundledSkillInput {
	bundle: HostedBundledSkillBundle;
	targetDir: string;
	/** A root-owned reservation for this exact target authorizes replacement. */
	reserved?: boolean;
	/** Deterministic failure hooks for the shared activation contract. */
	activation?: ManagedSkillDirectoryActivationOptions;
}

interface HostedBundledSkillFile {
	readonly relativePath: string;
	readonly mode: 0o644 | 0o755;
	/** Base64 keeps the captured bytes immutable across the privilege boundary. */
	readonly contentBase64: string;
}

export interface HostedBundledSkillBundle {
	readonly catalogEntry: HostedBundledSkillCatalogEntry;
	readonly files: readonly HostedBundledSkillFile[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readHostedBundledSkillMarker(targetDir: string): Record<string, unknown> | null {
	const markerPath = join(targetDir, HOSTED_BUNDLED_SKILL_MARKER);
	try {
		if (!lstatSync(markerPath).isFile()) return null;
		const marker = JSON.parse(readFileSync(markerPath, "utf-8")) as unknown;
		return isPlainRecord(marker) ? marker : null;
	} catch {
		return null;
	}
}

function isCurrentManagedMarker(marker: Record<string, unknown>, skillId: string): boolean {
	return (
		marker.schema === HOSTED_BUNDLED_SKILL_MARKER_SCHEMA &&
		marker.owner === HOSTED_BUNDLED_SKILL_OWNER &&
		marker.id === skillId &&
		typeof marker.version === "number" &&
		Number.isSafeInteger(marker.version) &&
		marker.version > 0 &&
		typeof marker.digest === "string" &&
		/^[a-f0-9]{64}$/.test(marker.digest)
	);
}

function isLegacyManagedMarker(marker: Record<string, unknown>, skillId: string): boolean {
	return marker.managedBy === HOSTED_BUNDLED_SKILL_OWNER && marker.skillName === skillId;
}

export function isManagedHostedBundledSkill(targetDir: string, skillId: string): boolean {
	try {
		if (!lstatSync(targetDir).isDirectory()) return false;
	} catch {
		return false;
	}
	const marker = readHostedBundledSkillMarker(targetDir);
	return Boolean(
		marker && (isCurrentManagedMarker(marker, skillId) || isLegacyManagedMarker(marker, skillId)),
	);
}

function collectHostedBundledSkillFiles(
	currentDir: string,
	relativeDir: string,
	excludeMarker: boolean,
	requireCanonicalModes: boolean,
	files: ManagedBundleHashEntry[],
): void {
	const entries = readdirSync(currentDir, { withFileTypes: true }).sort((left, right) =>
		left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
	);
	for (const entry of entries) {
		const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
		if (excludeMarker && relativePath === HOSTED_BUNDLED_SKILL_MARKER) continue;
		const path = join(currentDir, entry.name);
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) {
			throw new Error(`symbolic links are not supported in bundled hosted skills: ${path}`);
		}
		if (stat.isDirectory()) {
			if (requireCanonicalModes && (stat.mode & 0o777) !== HOSTED_BUNDLED_SKILL_DIRECTORY_MODE) {
				throw new Error(`bundled hosted skill directory mode is not canonical: ${path}`);
			}
			collectHostedBundledSkillFiles(
				path,
				relativePath,
				excludeMarker,
				requireCanonicalModes,
				files,
			);
			continue;
		}
		if (stat.isFile()) {
			const mode = stat.mode & 0o777;
			if (requireCanonicalModes && mode !== canonicalManagedBundleFileMode(mode)) {
				throw new Error(`bundled hosted skill file mode is not canonical: ${path}`);
			}
			files.push({ relativePath, mode, content: readFileSync(path) });
			continue;
		}
		throw new Error(`unsupported file type in bundled hosted skill: ${path}`);
	}
}

function hostedBundledSkillDigest(
	directory: string,
	excludeMarker: boolean,
	requireCanonicalModes = false,
): string {
	const stat = lstatSync(directory);
	if (!stat.isDirectory()) {
		throw new Error(`bundled hosted skill path is not a directory: ${directory}`);
	}
	if (requireCanonicalModes && (stat.mode & 0o777) !== HOSTED_BUNDLED_SKILL_DIRECTORY_MODE) {
		throw new Error(`bundled hosted skill directory mode is not canonical: ${directory}`);
	}
	const files: ManagedBundleHashEntry[] = [];
	collectHostedBundledSkillFiles(directory, "", excludeMarker, requireCanonicalModes, files);
	return computeManagedBundleHash(files);
}

export function managedSkillDirectoryDigest(directory: string): string {
	return hostedBundledSkillDigest(directory, false);
}

export function adoptableLegacyHostedBundledSkill(
	targetDir: string,
	skillId: string,
): HostedBundledSkillCatalogEntry | null {
	const marker = readHostedBundledSkillMarker(targetDir);
	if (!marker) return null;
	const current = isCurrentManagedMarker(marker, skillId);
	const legacy = isLegacyManagedMarker(marker, skillId);
	if (!current && !legacy) return null;
	const version = current ? (marker.version as number) : 1;
	let catalogEntry: HostedBundledSkillCatalogEntry;
	try {
		catalogEntry = resolveHostedBundledSkill(skillId, version);
	} catch {
		return null;
	}
	if (current && marker.digest !== catalogEntry.digest) return null;
	try {
		return hostedBundledSkillDigest(targetDir, true, true) === catalogEntry.digest
			? catalogEntry
			: null;
	} catch {
		return null;
	}
}

function normalizeHostedBundledSkillModes(currentDir: string): void {
	chmodSync(currentDir, HOSTED_BUNDLED_SKILL_DIRECTORY_MODE);
	for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
		const path = join(currentDir, entry.name);
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) {
			throw new Error(`symbolic links are not supported in bundled hosted skills: ${path}`);
		}
		if (stat.isDirectory()) {
			normalizeHostedBundledSkillModes(path);
			continue;
		}
		if (stat.isFile()) {
			chmodSync(path, canonicalManagedBundleFileMode(stat.mode & 0o777));
			continue;
		}
		throw new Error(`unsupported file type in bundled hosted skill: ${path}`);
	}
}

function markerMatches(
	marker: Record<string, unknown> | null,
	expected: HostedBundledSkillMarker,
): boolean {
	return Boolean(
		marker &&
			Object.keys(marker).length === 5 &&
			marker.schema === expected.schema &&
			marker.owner === expected.owner &&
			marker.id === expected.id &&
			marker.version === expected.version &&
			marker.digest === expected.digest,
	);
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
	const actualDigest = hostedBundledSkillDigest(sourceDir, false);
	if (actualDigest !== catalogEntry.digest) {
		throw new Error(
			`bundled hosted skill catalog digest mismatch for ${catalogEntry.id} version ${catalogEntry.version}`,
		);
	}
}

export function loadHostedBundledSkill(
	skillId: string,
	version: number,
	sourceDir: string,
): HostedBundledSkillBundle {
	const catalogEntry = resolveHostedBundledSkill(skillId, version);
	const sourceFiles: ManagedBundleHashEntry[] = [];
	const stat = lstatSync(sourceDir);
	if (!stat.isDirectory()) {
		throw new Error(`bundled hosted skill path is not a directory: ${sourceDir}`);
	}
	collectHostedBundledSkillFiles(sourceDir, "", false, false, sourceFiles);
	if (computeManagedBundleHash(sourceFiles) !== catalogEntry.digest) {
		throw new Error(
			`bundled hosted skill catalog digest mismatch for ${catalogEntry.id} version ${catalogEntry.version}`,
		);
	}
	const files = sourceFiles.map((file) =>
		Object.freeze({
			relativePath: file.relativePath,
			mode: canonicalManagedBundleFileMode(file.mode),
			contentBase64: Buffer.from(file.content).toString("base64"),
		}),
	);
	return Object.freeze({ catalogEntry, files: Object.freeze(files) });
}

function materializeHostedBundledSkill(bundle: HostedBundledSkillBundle, targetDir: string): void {
	mkdirSync(targetDir, { recursive: true, mode: HOSTED_BUNDLED_SKILL_DIRECTORY_MODE });
	for (const file of bundle.files) {
		const path = join(targetDir, file.relativePath);
		mkdirSync(dirname(path), { recursive: true, mode: HOSTED_BUNDLED_SKILL_DIRECTORY_MODE });
		writeFileSync(path, Buffer.from(file.contentBase64, "base64"), { mode: file.mode });
	}
}

export function withStagedHostedBundledSkill<T>(
	bundle: HostedBundledSkillBundle,
	operation: (sourceDir: string) => T,
): T {
	const stagingRoot = mkdtempSync(join(tmpdir(), "clawdi-hosted-bundled-skill-"));
	const sourceDir = join(stagingRoot, bundle.catalogEntry.id);
	try {
		materializeHostedBundledSkill(bundle, sourceDir);
		normalizeHostedBundledSkillModes(stagingRoot);
		if (hostedBundledSkillDigest(sourceDir, false, true) !== bundle.catalogEntry.digest) {
			throw new Error(
				`bundled hosted skill catalog digest mismatch for ${bundle.catalogEntry.id} version ${bundle.catalogEntry.version}`,
			);
		}
		return operation(sourceDir);
	} finally {
		rmSync(stagingRoot, { recursive: true, force: true });
	}
}

export function reconcileHostedBundledSkill(
	input: ReconcileHostedBundledSkillInput,
): "unchanged" | "replaced" {
	const catalogEntry = input.bundle.catalogEntry;
	const marker: HostedBundledSkillMarker = {
		schema: HOSTED_BUNDLED_SKILL_MARKER_SCHEMA,
		owner: HOSTED_BUNDLED_SKILL_OWNER,
		id: catalogEntry.id,
		version: catalogEntry.version,
		digest: catalogEntry.digest,
	};
	const targetExists = existsSync(input.targetDir);
	if (
		targetExists &&
		!input.reserved &&
		!isManagedHostedBundledSkill(input.targetDir, catalogEntry.id)
	) {
		throw new Error(`refusing to replace unmanaged ${catalogEntry.id} skill at ${input.targetDir}`);
	}
	if (targetExists && markerMatches(readHostedBundledSkillMarker(input.targetDir), marker)) {
		try {
			if (hostedBundledSkillDigest(input.targetDir, true, true) === marker.digest)
				return "unchanged";
		} catch {
			// A recognized managed target with tampered content is replaced below.
		}
	}

	const parent = dirname(input.targetDir);
	mkdirSync(parent, { recursive: true });
	const stagingRoot = mkdtempSync(join(parent, `.${basename(input.targetDir)}-stage-`));
	const stagedTarget = join(stagingRoot, basename(input.targetDir));
	const trash = join(parent, `.${basename(input.targetDir)}-trash-${process.pid}-${randomUUID()}`);
	try {
		materializeHostedBundledSkill(input.bundle, stagedTarget);
		normalizeHostedBundledSkillModes(stagedTarget);
		if (hostedBundledSkillDigest(stagedTarget, false, true) !== catalogEntry.digest) {
			throw new Error(
				`bundled hosted skill catalog digest mismatch for ${catalogEntry.id} version ${catalogEntry.version}`,
			);
		}
		writeFileSync(
			join(stagedTarget, HOSTED_BUNDLED_SKILL_MARKER),
			`${JSON.stringify(marker, null, 2)}\n`,
			{ mode: 0o600 },
		);
		activateManagedSkillDirectory({
			stagedTarget,
			targetDir: input.targetDir,
			previousTarget: trash,
			options: input.activation,
		});
	} finally {
		rmSync(stagingRoot, { recursive: true, force: true });
	}
	return "replaced";
}
