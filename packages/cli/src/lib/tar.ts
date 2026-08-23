import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	renameSync,
	rmSync,
} from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createGunzip, gunzipSync } from "node:zlib";
import * as tar from "tar";
import { assertValidSkillKey } from "./skill-key";

/**
 * Directories that should never end up inside an uploaded skill tarball.
 * Skills are agent instructions + small helper files — `node_modules/` and
 * build artifacts blow past the upstream 100MB cap and aren't useful to the
 * recipient anyway. Mirrors `SKIP_DIRS` from `adapters/paths.ts` (kept
 * duplicated to avoid an adapter→tar import edge) and extends it with
 * ecosystem dirs that the adapters' enumeration doesn't otherwise filter.
 *
 * Exported because `lib/skills-lock.ts`'s file-tree hash function MUST
 * filter the same set — what we hash has to equal what we'd tar, otherwise
 * the cache could "match" while the actual archive contains different
 * bytes. See lib/skills-lock.ts for the hash-side use. The Python side
 * (`backend/app/routes/skills.py:_SKILL_HASH_EXCLUDE`) mirrors this list
 * with a comment pointing back here; if you add a directory, add it in
 * both places.
 */
export const SKILL_TAR_EXCLUDE = new Set([
	"node_modules",
	".git",
	".turbo",
	".cache",
	"dist",
	"build",
	"out",
	"target",
	"__pycache__",
	".venv",
	"venv",
	".pytest_cache",
	".mypy_cache",
	".ruff_cache",
	".tox",
	"coverage",
	// Cross-agent skill bundles. gstack and similar meta-skills
	// ship sub-skills FOR OTHER AGENTS inside their own root
	// (e.g. `gstack/.agents/skills/<sub>` is meant to be loaded
	// by openclaw / hermes adapters, not codex/claude_code).
	// They're not part of the outer skill's runtime contract,
	// they balloon the tarball past the 25 MB cap, and the
	// dotfile prefix means the resolver wouldn't even enqueue
	// changes inside them (see resolveOwningSkillKey). Keeping
	// them out of the outer skill's tar lets gstack-shaped
	// folders fit under the cap. Pre-fix gstack itself failed
	// upload with HTTP 413 because the bundled subtrees pushed
	// it past 25 MB.
	".agents",
	".cursor",
	".factory",
	".openclaw",
	".hermes",
	".gbrain",
	".claude",
	".codex",
]);

/** Extraction ceilings for Agent-authored Skill archives. The compressed
 * upload limit alone cannot contain a gzip bomb, so extraction also bounds
 * declared file content and the actual decompressed tar stream. */
export const SKILL_ARCHIVE_EXTRACTION_LIMITS = Object.freeze({
	entryCount: 1_024,
	entryBytes: 16 * 1024 * 1024,
	totalEntryBytes: 32 * 1024 * 1024,
	// Includes tar headers, block padding, and extended metadata in addition
	// to file content. This stays above the maximum legitimate entry payload
	// plus worst-case ordinary header/padding overhead at the entry-count cap.
	expandedTarBytes: 36 * 1024 * 1024,
});

function isRegularArchiveFile(type: string | undefined): boolean {
	return type === "File" || type === "OldFile" || type === "ContiguousFile";
}

function isAllowedArchiveEntry(type: string | undefined): boolean {
	return isRegularArchiveFile(type) || type === "Directory";
}

function isReservedSkillArchivePath(path: string): boolean {
	return path.split(/[\\/]/).some((segment) => segment.toLowerCase().startsWith(".clawdi-managed"));
}

export interface TarExtractionLimits {
	entryCount: number;
	fileCount?: number;
	entryBytes: number;
	totalEntryBytes: number;
	expandedTarBytes: number;
}

export interface TarExtractionOptions {
	limits?: TarExtractionLimits;
	resourceLabel?: string;
	filter?: (path: string, entry: ArchiveEntry) => boolean;
	allowReservedManagementPaths?: boolean;
}

interface ArchiveEntry {
	size: number;
	type?: string;
}

function extractionFilter(
	options: TarExtractionOptions,
): (path: string, entry: ArchiveEntry) => boolean {
	const limits = options.limits ?? SKILL_ARCHIVE_EXTRACTION_LIMITS;
	const fileCountLimit = "fileCount" in limits ? limits.fileCount : undefined;
	const label = options.resourceLabel ?? "Skill archive";
	let entryCount = 0;
	let fileCount = 0;
	let totalEntryBytes = 0;
	return (path, entry) => {
		if (options.filter && !options.filter(path, entry)) return false;
		if (path.includes("..") || path.startsWith("/")) return false;
		if (!options.allowReservedManagementPaths && isReservedSkillArchivePath(path)) {
			throw new Error(`${label} contains reserved management metadata`);
		}
		const type = "type" in entry ? entry.type : undefined;
		if (!isAllowedArchiveEntry(type)) {
			throw new Error(`${label} contains an unsupported entry type`);
		}
		entryCount += 1;
		if (entryCount > limits.entryCount) {
			throw new Error(`${label} exceeds ${limits.entryCount} entries`);
		}
		const size = entry.size;
		if (!Number.isSafeInteger(size) || size < 0) {
			throw new Error(`${label} contains an invalid entry size`);
		}
		if (size > limits.entryBytes) {
			throw new Error(`${label} entry exceeds ${limits.entryBytes} bytes`);
		}
		if (isRegularArchiveFile(type)) {
			fileCount += 1;
			if (fileCountLimit !== undefined && fileCount > fileCountLimit) {
				throw new Error(`${label} exceeds ${fileCountLimit} files`);
			}
		}
		totalEntryBytes += size;
		if (totalEntryBytes > limits.totalEntryBytes) {
			throw new Error(`${label} exceeds ${limits.totalEntryBytes} total entry bytes`);
		}
		return true;
	};
}

/**
 * Extract a gzipped tar archive into `cwd`.
 *
 * Use this instead of `tar.extract({...}).end(bytes)` — `.end()` returns the
 * stream (not a promise), so `await tar.extract(...).end(bytes)` resolves
 * immediately, before extraction completes. tar's public Unpack completion
 * boundary is `close`, emitted in a finalization microtask after `finish` and
 * `end`; waiting for `finish` lets the caller resume before that finalization.
 */
export function extractTarGz(
	cwd: string,
	bytes: Buffer,
	options: TarExtractionOptions = {},
): Promise<void> {
	const limits = options.limits ?? SKILL_ARCHIVE_EXTRACTION_LIMITS;
	const label = options.resourceLabel ?? "Skill archive";
	return assertExpandedTarLimit(bytes, limits.expandedTarBytes, label).then(
		() =>
			new Promise((resolvePromise, reject) => {
				const stream = tar.extract({
					cwd,
					gzip: true,
					filter: extractionFilter(options),
				});
				stream.on("close", () => resolvePromise());
				stream.on("error", reject);
				stream.end(bytes);
			}),
	);
}

export function extractTarGzSync(
	cwd: string,
	bytes: Buffer,
	options: TarExtractionOptions = {},
): void {
	const limits = options.limits ?? SKILL_ARCHIVE_EXTRACTION_LIMITS;
	const label = options.resourceLabel ?? "Skill archive";
	let expanded: Buffer;
	try {
		expanded = gunzipSync(bytes, { maxOutputLength: limits.expandedTarBytes });
	} catch (error) {
		throw new Error(
			`${label} is invalid or exceeds ${limits.expandedTarBytes} expanded tar bytes`,
			{
				cause: error,
			},
		);
	}
	const stream = tar.extract({
		cwd,
		sync: true,
		filter: extractionFilter(options),
	});
	stream.end(expanded);
}

/** Decompress once into a counting sink before giving the archive to tar.
 * This makes the absolute expansion limit independent of tar EOF/backpressure
 * behavior and guarantees a gzip bomb is rejected before extraction writes. */
export function assertExpandedTarLimit(
	bytes: Buffer,
	limit = SKILL_ARCHIVE_EXTRACTION_LIMITS.expandedTarBytes,
	label = "Skill archive",
): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		let expandedTarBytes = 0;
		let settled = false;
		const gunzip = createGunzip();
		const fail = (error: Error): void => {
			if (settled) return;
			settled = true;
			gunzip.destroy();
			reject(error);
		};
		gunzip.on("error", (error) => fail(error));
		gunzip.on("data", (chunk: Buffer) => {
			expandedTarBytes += chunk.length;
			if (expandedTarBytes > limit) {
				fail(new Error(`${label} exceeds ${limit} expanded tar bytes`));
			}
		});
		gunzip.on("end", () => {
			if (settled) return;
			settled = true;
			resolvePromise();
		});
		gunzip.end(bytes);
	});
}

/**
 * Atomically replace a skill directory from a downloaded archive.
 *
 * Staging is a sibling of `skillsRoot`, never a child of it. This keeps
 * temporary `<skillKey>/SKILL.md` trees and old-version trash outside the
 * watched skills root. The explicit root also preserves nested Hermes keys:
 * extracting `category/foo` is validated at `join(stageRoot, skillKey)`
 * instead of inferring an extraction root from `dirname(targetDir)`.
 */
export async function replaceSkillArchiveTarGz(
	skillKey: string,
	skillsRoot: string,
	targetDir: string,
	bytes: Buffer,
	beforeActivate?: () => void,
	commitMutation: (mutation: () => void) => void = (mutation) => mutation(),
): Promise<void> {
	assertValidSkillKey(skillKey);
	const targetFromRoot = relative(skillsRoot, targetDir);
	if (!targetFromRoot || targetFromRoot.startsWith("..") || isAbsolute(targetFromRoot)) {
		throw new Error(`Skill target must be inside skills root: ${targetDir}`);
	}
	mkdirSync(skillsRoot, { recursive: true });
	const realSkillsRoot = realpathSync(skillsRoot);
	const skillsParent = dirname(realSkillsRoot);
	const stageRoot = mkdtempSync(join(skillsParent, `.${basename(skillsRoot)}-stage-`));
	const stagedSkill = join(stageRoot, skillKey);
	const trash = join(stageRoot, ".previous");
	let preserveStageForRecovery = false;
	try {
		await extractTarGz(stageRoot, bytes);
		if (!existsSync(stagedSkill) || !lstatSync(stagedSkill).isDirectory()) {
			throw new Error(`Skill tarball did not contain expected '${skillKey}/' root entry`);
		}
		mkdirSync(dirname(targetDir), { recursive: true });
		commitMutation(() => {
			let previousMoved = false;
			if (existsSync(targetDir)) {
				renameSync(targetDir, trash);
				previousMoved = true;
			}
			try {
				beforeActivate?.();
				renameSync(stagedSkill, targetDir);
			} catch (installError) {
				if (!previousMoved) throw installError;
				try {
					renameSync(trash, targetDir);
				} catch (restoreError) {
					preserveStageForRecovery = true;
					const installMessage =
						installError instanceof Error ? installError.message : String(installError);
					const restoreMessage =
						restoreError instanceof Error ? restoreError.message : String(restoreError);
					throw new Error(
						`Skill install failed: ${installMessage}; restoring the previous version failed: ${restoreMessage}; previous version retained at ${trash}`,
						{ cause: installError },
					);
				}
				throw installError;
			}
			if (existsSync(trash)) rmSync(trash, { recursive: true, force: true });
		});
	} finally {
		if (!preserveStageForRecovery) {
			rmSync(stageRoot, { recursive: true, force: true });
		}
	}
}

/**
 * Walk `dirPath` looking for symlinks whose resolved target falls
 * outside the trusted area. Returns the list of offending source
 * paths; an empty array means every symlink stays inside.
 *
 * `tar.create({follow: true})` inlines symlink targets into the
 * archive. Without this scan, a skill containing
 * `mySkill/secrets -> /etc/passwd` would happily upload the
 * pointed-at file as a regular tar entry. We need to allow
 * symlinks but bound them to a trust zone.
 *
 * `trustRoot` defaults to the skill's PARENT directory (the agent's
 * skills folder), not the skill directory itself. gstack-style
 * skills use sibling symlinks like
 * `~/.claude/skills/autoplan/SKILL.md → ~/.claude/skills/gstack/autoplan/SKILL.md`
 * — both ends are under the user's own skills tree, so the bound
 * is at the parent. A symlink pointing to `/etc/passwd` or
 * anywhere outside `~/.claude/skills/` is still rejected.
 */
async function findEscapingSymlinks(
	dirPath: string,
	trustRoot?: string | string[],
): Promise<string[]> {
	const skillRoot = await realpath(dirPath);
	// Multiple trust roots supported so a staged copy (`clawdi
	// skill add` of a sanitized name) can simultaneously trust
	// the original source tree (where absolute symlinks point)
	// AND the tmpdir staging the copy was placed in (where
	// preserved relative symlinks resolve). Single-string passes
	// are normalised to a one-element array; the legacy default
	// (skill's parent dir) still applies when `trustRoot` is
	// absent.
	const candidates = Array.isArray(trustRoot)
		? trustRoot
		: trustRoot !== undefined
			? [trustRoot]
			: [dirname(skillRoot)];
	const trustRootsResolved = await Promise.all(candidates.map((r) => realpath(r).catch(() => r)));
	const isInsideTrust = (target: string): boolean => {
		for (const root of trustRootsResolved) {
			if (target === root || target.startsWith(`${root}/`)) return true;
		}
		return false;
	};
	const escaping: string[] = [];

	// Canonical directory identities make the validation graph explicit.
	// A completed directory can be reused by multiple safe symlinks, while a
	// target already on the active recursion stack is a cycle and must fail
	// closed before `tar.create({ follow: true })` can recurse into it.
	const completedDirectories = new Set<string>();
	const activeDirectories = new Set<string>();
	const walk = async (current: string): Promise<void> => {
		let canonicalCurrent: string;
		try {
			canonicalCurrent = await realpath(current);
		} catch {
			escaping.push(current);
			return;
		}
		if (activeDirectories.has(canonicalCurrent)) {
			escaping.push(current);
			return;
		}
		if (completedDirectories.has(canonicalCurrent)) return;
		activeDirectories.add(canonicalCurrent);
		const entries = await readdir(current, { withFileTypes: true });
		try {
			for (const ent of entries) {
				if (SKILL_TAR_EXCLUDE.has(ent.name)) continue;
				const fullPath = join(current, ent.name);
				if (ent.isSymbolicLink()) {
					try {
						const target = await realpath(fullPath);
						if (!isInsideTrust(target)) {
							escaping.push(fullPath);
							continue;
						}
						const targetStats = await lstat(target);
						if (targetStats.isDirectory()) await walk(target);
					} catch {
						// Broken, racing, or cyclic links cannot be represented as
						// a stable dereferenced projection.
						escaping.push(fullPath);
					}
					continue;
				}
				if (ent.isDirectory()) {
					try {
						const stats = await lstat(fullPath);
						if (stats.isDirectory()) await walk(fullPath);
					} catch {
						// A vanished ordinary directory contributes no archive bytes.
					}
				}
			}
		} finally {
			activeDirectories.delete(canonicalCurrent);
			completedDirectories.add(canonicalCurrent);
		}
	};

	await walk(dirPath);
	return escaping;
}

/**
 * Create a tar.gz buffer from a skill directory.
 *
 * `follow: true` dereferences symlinks at archive time. gstack-style skills
 * use symlinks heavily (e.g. `autoplan/SKILL.md` → a shared template that
 * lives under a sibling directory in the same agent skills folder) and the
 * backend rejects archives containing symlink entries for security.
 * Following inlines the real file content, which is what the user actually
 * wants uploaded anyway.
 *
 * BEFORE following, walk the tree and refuse to archive if any symlink
 * resolves outside the trust zone. The default trust zone is the parent
 * skills directory — broad enough to allow gstack-style sibling symlinks
 * (autoplan → gstack/autoplan) but tight enough to still reject
 * `secrets → /etc/passwd` or anything else outside the agent's skills
 * tree. Pass `trustRoot` to override (e.g. for a test fixture rooted in
 * `/tmp`).
 */
export async function tarSkillDir(
	dirPath: string,
	trustRoot?: string | string[],
	skillKey?: string,
): Promise<Buffer> {
	// `skillKey` is the cloud-side identifier of the skill. For
	// flat layouts it equals `basename(dirPath)`; for Hermes
	// nested layouts it's `category/foo` etc. The archive's
	// directory entries MUST use the full key as the prefix so a
	// later projection/import extraction at the skills root recreates the
	// correct on-disk path. Pre-fix the daemon archived only
	// `basename(dirPath)` (e.g. `foo/`) for a `category/foo`
	// upload — the cloud row was keyed `category/foo` but the
	// extracted bytes landed at the wrong path on every other
	// machine.
	const archivePath = skillKey ?? basename(dirPath);
	// Walk up so `cwd` is the directory under which the archive
	// path lives. For "foo" (flat) this is one level up
	// (parent of `<root>/foo`). For "category/foo" (nested) it's
	// two levels up — landing at `<rootDir>` itself.
	const components = archivePath.split("/").filter(Boolean);
	let cwd = dirPath;
	for (let i = 0; i < components.length; i++) {
		cwd = resolve(cwd, "..");
	}

	// Symlink trust root defaults to the SKILLS ROOT we just
	// derived (`cwd`), not the skill's immediate parent. For flat
	// keys these are the same directory; for nested Hermes keys
	// they differ — `dirname(<skills>/category/foo) == <skills>/category`,
	// so a legitimate sibling symlink under `<skills>/another-category`
	// would be incorrectly flagged as escaping by the default
	// `findEscapingSymlinks` fallback. Using the agent's actual
	// skills root preserves gstack-style cross-skill symlinks
	// while still rejecting `secrets -> /etc/passwd` and anything
	// outside the user's own skills tree.
	const escaping = await findEscapingSymlinks(dirPath, trustRoot ?? cwd);
	if (escaping.length > 0) {
		throw new Error(
			`Skill contains symlink(s) pointing outside the agent's skills directory, broken, or cyclic; refusing to upload: ${escaping.join(", ")}`,
		);
	}

	const chunks: Buffer[] = [];
	await tar
		.create(
			{
				gzip: true,
				cwd,
				follow: true,
				// Strip `node_modules/`, `.git/`, build output, virtualenvs, etc.
				// The `tar` package passes both files and directories through this
				// filter; returning false for a directory excludes the whole subtree.
				// `path` is relative to `cwd` and uses POSIX separators. With a
				// nested skillKey like `category/foo`, the first N segments are the
				// key components themselves — skip ALL of them so a skill
				// legitimately named `dist`/`build`/`out` (or whose category dir
				// is) doesn't get packaged as an empty tarball.
				filter: (path) => {
					if (isReservedSkillArchivePath(path)) {
						throw new Error("Skill contains reserved management metadata");
					}
					const segments = path.split("/").slice(components.length);
					return !segments.some((seg) => SKILL_TAR_EXCLUDE.has(seg));
				},
			},
			[archivePath],
		)
		.on("data", (chunk: Buffer) => chunks.push(chunk))
		.promise();
	return Buffer.concat(chunks);
}

/** Hash the exact dereferenced regular-file projection carried by a Skill
 * archive. The ordering and `path + bytes` framing intentionally match the
 * backend's published hash contract and Python's codepoint string ordering. */
export async function computeSkillArchiveHash(bytes: Buffer, skillKey?: string): Promise<string> {
	const stripCount = skillKey ? skillKey.split("/").length : 1;
	const fileReads: Array<Promise<{ relativePath: string; content: Buffer }>> = [];
	const stream = tar.list({
		gzip: true,
		onReadEntry: (entry) => {
			if (!isRegularArchiveFile(entry.type)) {
				entry.resume();
				return;
			}
			const parts = entry.path.split("/");
			const relativeParts = parts.slice(stripCount);
			const relativePath = relativeParts.join("/");
			if (!relativePath || relativeParts.some((part) => SKILL_TAR_EXCLUDE.has(part))) {
				entry.resume();
				return;
			}
			fileReads.push(
				entry.concat().then((content) => ({ relativePath, content: Buffer.from(content) })),
			);
		},
	});
	await new Promise<void>((resolvePromise, reject) => {
		stream.on("end", resolvePromise);
		stream.on("error", reject);
		stream.end(bytes);
	});
	const files = await Promise.all(fileReads);
	files.sort((a, b) => compareUnicodeCodePoints(a.relativePath, b.relativePath));
	const hash = createHash("sha256");
	for (const file of files) {
		hash.update(file.relativePath);
		hash.update(file.content);
	}
	return hash.digest("hex");
}

/** Match Python's lexicographic `str` ordering by Unicode code point.
 * JavaScript's relational string operators compare UTF-16 code units, which
 * orders astral characters before some BMP characters and breaks server hash
 * parity for otherwise valid archive paths. */
export function compareUnicodeCodePoints(left: string, right: string): number {
	const leftIterator = left[Symbol.iterator]();
	const rightIterator = right[Symbol.iterator]();
	while (true) {
		const leftNext = leftIterator.next();
		const rightNext = rightIterator.next();
		if (leftNext.done || rightNext.done) {
			if (leftNext.done && rightNext.done) return 0;
			return leftNext.done ? -1 : 1;
		}
		const leftPoint = leftNext.value.codePointAt(0);
		const rightPoint = rightNext.value.codePointAt(0);
		if (leftPoint === undefined || rightPoint === undefined) {
			throw new Error("Unicode iterator returned an empty code point");
		}
		if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
	}
}

/** Capture one validated archive and the published hash of those exact bytes. */
export async function snapshotSkillArchive(
	dirPath: string,
	trustRoot?: string | string[],
	skillKey?: string,
): Promise<{ archive: Buffer; hash: string }> {
	const archive = await tarSkillDir(dirPath, trustRoot, skillKey);
	return { archive, hash: await computeSkillArchiveHash(archive, skillKey) };
}

/**
 * Create a tar.gz buffer wrapping a single file as {key}/SKILL.md.
 */
export async function tarSingleFile(skillKey: string, content: string): Promise<Buffer> {
	const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");

	const tmpDir = mkdtempSync(join(tmpdir(), "clawdi-skill-"));
	const skillDir = join(tmpDir, skillKey);
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(join(skillDir, "SKILL.md"), content);

	const chunks: Buffer[] = [];
	await tar
		.create({ gzip: true, cwd: tmpDir }, [skillKey])
		.on("data", (chunk: Buffer) => chunks.push(chunk))
		.promise();
	const result = Buffer.concat(chunks);

	rmSync(tmpDir, { recursive: true, force: true });
	return result;
}
