import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GithubArchiveFetcher } from "../lib/github-skill-archive";
import {
	fetchGithubSkillArchive,
	parseCanonicalGithubRepositoryUrl,
	readBoundedResponseBytes,
} from "../lib/github-skill-archive";
import { writePrivateFileAtomic } from "../lib/private-file";
import { extractTarGz, snapshotSkillArchive } from "../lib/tar";
import type { RuntimeManifest } from "./manifest-contract";
import type { HostedSkillSource } from "./manifest-resources";
import type { RuntimePaths } from "./paths";

// Legacy compatibility: persisted receipts keep their original schema identifier.
const CACHE_SCHEMA = "clawdi.hostedCatalogSkillArchive.v1";
const MAX_CACHED_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_PROJECT_SKILL_ARCHIVE_BYTES = 25 * 1024 * 1024;

interface HostedSourcedSkillArchiveReceipt {
	schemaVersion: typeof CACHE_SCHEMA;
	skillId: string;
	source: HostedSkillSource;
	sha256: string;
}

export interface PreparedHostedSourcedSkill {
	skillId: string;
	source: HostedSkillSource;
	/** Stable canonical ownership identity; independent of tar encoding and cache lifetime. */
	sourceIdentity: string;
	/** Byte hash used only to detect corruption in the local archive cache. */
	archiveSha256: string;
	tarBytes: Buffer;
}

function sha256(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function sourceIdentity(skillId: string, source: HostedSkillSource): string {
	return source.type === "github"
		? ["github", skillId, source.url, source.path, source.commit].join("\0")
		: ["project", skillId, source.projectId, source.contentHash].join("\0");
}

function cachePaths(paths: RuntimePaths, skillId: string, source: HostedSkillSource) {
	const key = sha256(sourceIdentity(skillId, source));
	const root = join(paths.hostedSkillArchiveRoot, key);
	return { archive: join(root, "skill.tar.gz"), receipt: join(root, "receipt.json") };
}

function readCachedArchive(
	paths: RuntimePaths,
	skillId: string,
	source: HostedSkillSource,
): { archiveSha256: string; tarBytes: Buffer } | null {
	const cache = cachePaths(paths, skillId, source);
	if (!existsSync(cache.archive) || !existsSync(cache.receipt)) return null;
	try {
		const archiveStat = lstatSync(cache.archive);
		const receiptStat = lstatSync(cache.receipt);
		if (
			!archiveStat.isFile() ||
			archiveStat.isSymbolicLink() ||
			archiveStat.size > MAX_CACHED_ARCHIVE_BYTES ||
			!receiptStat.isFile() ||
			receiptStat.isSymbolicLink()
		) {
			return null;
		}
		const receipt = JSON.parse(readFileSync(cache.receipt, "utf8")) as unknown;
		if (!isReceipt(receipt)) return null;
		if (
			receipt.skillId !== skillId ||
			sourceIdentity(receipt.skillId, receipt.source) !== sourceIdentity(skillId, source)
		) {
			return null;
		}
		const tarBytes = readFileSync(cache.archive);
		if (sha256(tarBytes) !== receipt.sha256) return null;
		return { archiveSha256: receipt.sha256, tarBytes };
	} catch {
		return null;
	}
}

function isReceipt(value: unknown): value is HostedSourcedSkillArchiveReceipt {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const receipt = value as Record<string, unknown>;
	if (
		receipt.schemaVersion !== CACHE_SCHEMA ||
		typeof receipt.skillId !== "string" ||
		typeof receipt.sha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(receipt.sha256) ||
		typeof receipt.source !== "object" ||
		receipt.source === null ||
		Array.isArray(receipt.source)
	) {
		return false;
	}
	const source = receipt.source as Record<string, unknown>;
	return source.type === "github"
		? typeof source.url === "string" &&
				typeof source.path === "string" &&
				typeof source.commit === "string"
		: source.type === "project" &&
				typeof source.projectId === "string" &&
				typeof source.contentHash === "string" &&
				typeof source.archiveUrl === "string" &&
				typeof source.installUrl === "string";
}

function assertProjectSkillEndpoints(
	manifest: RuntimeManifest,
	skillId: string,
	source: Extract<HostedSkillSource, { type: "project" }>,
): void {
	const controlPlane = new URL(manifest.controlPlane.apiUrl);
	const archive = new URL(source.archiveUrl);
	const install = new URL(source.installUrl);
	if (archive.origin !== controlPlane.origin || install.origin !== controlPlane.origin) {
		throw new Error(`Project Skill ${skillId} download endpoints do not match the control plane`);
	}
	const archiveMatch =
		/^\/v1\/runtime\/project-skill-archives\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/([a-f0-9]{64})\/([a-f0-9]{64})\/([a-z0-9-]+)\.tar\.gz$/.exec(
			archive.pathname,
		);
	const installMatch =
		/^\/v1\/runtime\/project-skill-files\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/([a-f0-9]{64})\/([a-f0-9]{64})\/SKILL\.md$/.exec(
			install.pathname,
		);
	if (
		!archiveMatch ||
		!installMatch ||
		archiveMatch[1] !== manifest.environmentId ||
		archiveMatch[2] !== source.projectId ||
		archiveMatch[4] !== source.contentHash ||
		archiveMatch[6] !== skillId ||
		installMatch[1] !== manifest.environmentId ||
		installMatch[2] !== archiveMatch[3] ||
		installMatch[3] !== source.contentHash ||
		installMatch[4] !== archiveMatch[5]
	) {
		throw new Error(`Project Skill ${skillId} install endpoint is invalid`);
	}
}

async function fetchProjectSkillArchive(
	skillId: string,
	source: Extract<HostedSkillSource, { type: "project" }>,
	options: { authToken?: string; fetcher?: GithubArchiveFetcher },
): Promise<Buffer> {
	const headers = new Headers({ Accept: "application/gzip" });
	if (options.authToken) headers.set("Authorization", `Bearer ${options.authToken}`);
	const response = await (options.fetcher ?? fetch)(new URL(source.archiveUrl), {
		headers,
		redirect: "error",
	});
	if (!response.ok)
		throw new Error(`Project Skill ${skillId} download failed (${response.status})`);
	const downloaded = await readBoundedResponseBytes(response, MAX_PROJECT_SKILL_ARCHIVE_BYTES, {
		resourceLabel: "Project Skill archive",
		limitLabel: "25 MB",
	});

	const extractedRoot = mkdtempSync(join(tmpdir(), "clawdi-project-skill-"));
	try {
		await extractTarGz(extractedRoot, downloaded);
		const entries = readdirSync(extractedRoot);
		if (entries.length !== 1 || entries[0] !== skillId) {
			throw new Error(`Project Skill ${skillId} archive has an unexpected root layout`);
		}
		const skillDir = join(extractedRoot, skillId);
		const canonical = await snapshotSkillArchive(skillDir, extractedRoot, skillId);
		const skillEntries = readdirSync(skillDir);
		const matchesLegacySingleFileHash =
			skillEntries.length === 1 &&
			skillEntries[0] === "SKILL.md" &&
			sha256(readFileSync(join(skillDir, "SKILL.md"))) === source.contentHash;
		if (canonical.hash !== source.contentHash && !matchesLegacySingleFileHash) {
			throw new Error(`Project Skill ${skillId} archive does not match its content identity`);
		}
		return canonical.archive;
	} finally {
		rmSync(extractedRoot, { recursive: true, force: true });
	}
}

function writeCachedArchive(
	paths: RuntimePaths,
	skillId: string,
	source: HostedSkillSource,
	tarBytes: Buffer,
): string {
	const digest = sha256(tarBytes);
	const cache = cachePaths(paths, skillId, source);
	writePrivateFileAtomic(cache.archive, tarBytes, { mode: 0o600, dirMode: 0o700 });
	writePrivateFileAtomic(
		cache.receipt,
		`${JSON.stringify(
			{
				schemaVersion: CACHE_SCHEMA,
				skillId,
				source,
				sha256: digest,
			} satisfies HostedSourcedSkillArchiveReceipt,
			null,
			2,
		)}\n`,
		{ mode: 0o600, dirMode: 0o700 },
	);
	return digest;
}

export async function prepareHostedSourcedSkillArchives(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	options: { authToken?: string; fetcher?: GithubArchiveFetcher } = {},
): Promise<ReadonlyMap<string, PreparedHostedSourcedSkill>> {
	const prepared = new Map<string, PreparedHostedSourcedSkill>();
	if (manifest.runtimes.hermes?.enabled !== true && manifest.runtimes.openclaw?.enabled !== true)
		return prepared;
	for (const [skillId, desired] of Object.entries(manifest.projection?.skills?.entries ?? {}).sort(
		([left], [right]) => left.localeCompare(right),
	)) {
		if (!desired.enabled || !("source" in desired)) continue;
		if (desired.source.type === "project") {
			assertProjectSkillEndpoints(manifest, skillId, desired.source);
		}
		const cached = readCachedArchive(paths, skillId, desired.source);
		if (cached) {
			prepared.set(skillId, {
				skillId,
				source: desired.source,
				sourceIdentity: sourceIdentity(skillId, desired.source),
				archiveSha256: cached.archiveSha256,
				tarBytes: cached.tarBytes,
			});
			continue;
		}
		let tarBytes: Buffer;
		if (desired.source.type === "github") {
			const repository = parseCanonicalGithubRepositoryUrl(desired.source.url);
			const downloaded = await fetchGithubSkillArchive(
				{
					...repository,
					path: desired.source.path,
					ref: desired.source.commit,
				},
				{ skillKey: skillId, fetcher: options.fetcher },
			);
			if (downloaded.skillKey !== skillId) {
				throw new Error(`downloaded Skill identity does not match manifest entry ${skillId}`);
			}
			tarBytes = downloaded.tarBytes;
		} else {
			tarBytes = await fetchProjectSkillArchive(skillId, desired.source, options);
		}
		const archiveSha256 = writeCachedArchive(paths, skillId, desired.source, tarBytes);
		prepared.set(skillId, {
			skillId,
			source: desired.source,
			sourceIdentity: sourceIdentity(skillId, desired.source),
			archiveSha256,
			tarBytes,
		});
	}
	return prepared;
}
