import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { resolveCurrentCliResourceRoot } from "../lib/current-cli-invocation";
import type { GithubArchiveFetcher } from "../lib/github-skill-archive";
import {
	fetchGithubSkillArchive,
	parseCanonicalGithubRepositoryUrl,
	readBoundedResponseBytes,
} from "../lib/github-skill-archive";
import { extractTarGz, snapshotSkillArchive } from "../lib/tar";
import { archiveCache, gcArchiveCache } from "./archive-cache";
import {
	assertHostedBundledSkillCatalogDigest,
	resolveHostedBundledSkill,
} from "./hosted-bundled-skill";
import type { RuntimeManifest } from "./manifest-contract";
import { type HostedSkillSource, hostedSkillSourceSchema } from "./manifest-resources";
import type { RuntimePaths } from "./paths";

const CACHE_SCHEMA = "clawdi.hostedCatalogSkillArchive.v1";
const MAX_CACHED_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_PROJECT_SKILL_ARCHIVE_BYTES = 25 * 1024 * 1024;

type BundledSkillSource = {
	type: "bundled";
	version: number;
	digest: string;
	assetDirectory: string;
};

export type PreparedHostedSkill = {
	id: string;
	identity:
		| { source: BundledSkillSource; version: number; digest: string }
		| { source: HostedSkillSource; sourceIdentity: string; digest: string };
} & ({ sourceDir: string } | { tarBytes: Buffer });

function sha256(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function sourceIdentity(skillId: string, source: HostedSkillSource): string {
	return source.type === "github"
		? ["github", skillId, source.url, source.path, source.commit].join("\0")
		: ["project", skillId, source.projectId, source.contentHash].join("\0");
}

function sourceCacheKey(skillId: string, source: HostedSkillSource): string {
	return sha256(sourceIdentity(skillId, source));
}

const cacheReceiptSchema = z
	.object({
		schemaVersion: z.literal(CACHE_SCHEMA),
		skillId: z.string(),
		source: hostedSkillSourceSchema,
		sha256: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();
const cacheReceiptReader = {
	parse(value: unknown) {
		const receipt = cacheReceiptSchema.parse(value);
		return {
			key: sourceCacheKey(receipt.skillId, receipt.source),
			archiveSha256: receipt.sha256,
		};
	},
};

export function prepareHostedBundledSkill(skillId: string, version: number): PreparedHostedSkill {
	const catalogEntry = resolveHostedBundledSkill(skillId, version);
	const sourceDir = resolve(resolveCurrentCliResourceRoot(), "skills", catalogEntry.assetDirectory);
	if (basename(sourceDir) !== skillId || !existsSync(join(sourceDir, "SKILL.md"))) {
		throw new Error(`bundled hosted skill asset ${catalogEntry.assetDirectory} is unavailable`);
	}
	assertHostedBundledSkillCatalogDigest(catalogEntry, sourceDir);
	return {
		id: skillId,
		identity: {
			source: {
				type: "bundled",
				version,
				digest: catalogEntry.digest,
				assetDirectory: catalogEntry.assetDirectory,
			},
			version,
			digest: catalogEntry.digest,
		},
		sourceDir,
	};
}

function assertProjectSkillOrigin(
	manifest: RuntimeManifest,
	skillId: string,
	source: Extract<HostedSkillSource, { type: "project" }>,
): void {
	const origin = new URL(manifest.controlPlane.apiUrl).origin;
	if ([source.archiveUrl, source.installUrl].some((url) => new URL(url).origin !== origin)) {
		throw new Error(`Project Skill ${skillId} download endpoints do not match the control plane`);
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
		// SUNSET(hosted #1839): remove once the control plane has backfilled tree hashes for pre-2026-04-28 project skills.
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

export async function prepareHostedSkillArchives(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	options: { authToken?: string; fetcher?: GithubArchiveFetcher } = {},
): Promise<ReadonlyMap<string, PreparedHostedSkill>> {
	const prepared = new Map<string, PreparedHostedSkill>();
	if (manifest.runtimes.hermes?.enabled !== true && manifest.runtimes.openclaw?.enabled !== true) {
		return prepared;
	}
	for (const [skillId, desired] of Object.entries(manifest.projection?.skills?.entries ?? {}).sort(
		([left], [right]) => left.localeCompare(right),
	)) {
		if (!desired.enabled) continue;
		if (!("source" in desired)) {
			prepared.set(skillId, prepareHostedBundledSkill(skillId, desired.version));
			continue;
		}
		if (desired.source.type === "project") {
			assertProjectSkillOrigin(manifest, skillId, desired.source);
		}
		const identity = sourceIdentity(skillId, desired.source);
		const cacheKey = sourceCacheKey(skillId, desired.source);
		const cache = archiveCache(
			paths,
			paths.hostedSkillArchiveRoot,
			cacheKey,
			"skill.tar.gz",
			cacheReceiptReader,
			MAX_CACHED_ARCHIVE_BYTES,
		);
		let tarBytes = cache.read();
		if (!tarBytes) {
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
			if (cache.exists() && !cache.remove({ allowIncomplete: true })) {
				throw new Error("Skill archive cache path is not a managed cache entry");
			}
			cache.write(tarBytes, (archiveSha256) => ({
				schemaVersion: CACHE_SCHEMA,
				skillId,
				source: desired.source,
				sha256: archiveSha256,
			}));
		}
		prepared.set(skillId, {
			id: skillId,
			identity: { source: desired.source, sourceIdentity: identity, digest: sha256(tarBytes) },
			tarBytes,
		});
	}
	return prepared;
}

export function gcHostedSkillArchives(manifest: RuntimeManifest, paths: RuntimePaths): void {
	const keep = new Set<string>();
	if (manifest.runtimes.hermes?.enabled === true || manifest.runtimes.openclaw?.enabled === true) {
		for (const [skillId, desired] of Object.entries(manifest.projection?.skills?.entries ?? {})) {
			if (desired.enabled && "source" in desired) keep.add(sourceCacheKey(skillId, desired.source));
		}
	}
	gcArchiveCache(
		paths,
		paths.hostedSkillArchiveRoot,
		keep,
		"skill.tar.gz",
		cacheReceiptReader,
		MAX_CACHED_ARCHIVE_BYTES,
	);
}
