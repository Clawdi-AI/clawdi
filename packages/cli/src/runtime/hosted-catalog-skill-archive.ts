import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GithubArchiveFetcher } from "../lib/github-skill-archive";
import {
	fetchGithubSkillArchive,
	parseCanonicalGithubRepositoryUrl,
} from "../lib/github-skill-archive";
import { writePrivateFileAtomic } from "../lib/private-file";
import type { RuntimeManifest } from "./manifest-contract";
import type { HostedSkillSource } from "./manifest-resources";
import type { RuntimePaths } from "./paths";

const CACHE_SCHEMA = "clawdi.hostedCatalogSkillArchive.v1";
const MAX_CACHED_ARCHIVE_BYTES = 100 * 1024 * 1024;

interface HostedCatalogSkillArchiveReceipt {
	schemaVersion: typeof CACHE_SCHEMA;
	skillId: string;
	source: HostedSkillSource;
	sha256: string;
}

export interface PreparedHostedCatalogSkill {
	skillId: string;
	source: HostedSkillSource;
	digest: string;
	tarBytes: Buffer;
}

function sha256(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function sourceIdentity(skillId: string, source: HostedSkillSource): string {
	return JSON.stringify({ skillId, source });
}

function cachePaths(paths: RuntimePaths, skillId: string, source: HostedSkillSource) {
	const key = sha256(sourceIdentity(skillId, source));
	const root = join(paths.cacheRoot, "workspace-skills", key);
	return { archive: join(root, "skill.tar.gz"), receipt: join(root, "receipt.json") };
}

function readCachedArchive(
	paths: RuntimePaths,
	skillId: string,
	source: HostedSkillSource,
): { digest: string; tarBytes: Buffer } | null {
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
		return { digest: receipt.sha256, tarBytes };
	} catch {
		return null;
	}
}

function isReceipt(value: unknown): value is HostedCatalogSkillArchiveReceipt {
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
	return (
		source.type === "github" &&
		typeof source.url === "string" &&
		typeof source.path === "string" &&
		typeof source.commit === "string"
	);
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
			} satisfies HostedCatalogSkillArchiveReceipt,
			null,
			2,
		)}\n`,
		{ mode: 0o600, dirMode: 0o700 },
	);
	return digest;
}

export async function prepareHostedCatalogSkillArchives(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	options: { fetcher?: GithubArchiveFetcher } = {},
): Promise<ReadonlyMap<string, PreparedHostedCatalogSkill>> {
	const prepared = new Map<string, PreparedHostedCatalogSkill>();
	if (manifest.runtimes.hermes?.enabled !== true && manifest.runtimes.openclaw?.enabled !== true)
		return prepared;
	for (const [skillId, desired] of Object.entries(manifest.projection?.skills?.entries ?? {}).sort(
		([left], [right]) => left.localeCompare(right),
	)) {
		if (!desired.enabled || !("source" in desired)) continue;
		const cached = readCachedArchive(paths, skillId, desired.source);
		if (cached) {
			prepared.set(skillId, {
				skillId,
				source: desired.source,
				...cached,
			});
			continue;
		}
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
		prepared.set(skillId, {
			skillId,
			source: desired.source,
			digest: writeCachedArchive(paths, skillId, desired.source, downloaded.tarBytes),
			tarBytes: downloaded.tarBytes,
		});
	}
	return prepared;
}
