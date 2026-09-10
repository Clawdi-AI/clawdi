import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	accessSync,
	chmodSync,
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import * as tar from "tar";
import { evaluateHostPolicyForCommand } from "../runtime/host-policy";
import { getClawdiDir } from "./config";
import {
	currentNativeCompiledIdentity,
	type NativeCompiledIdentity,
	nativeVersionDirectoryName,
	validateNativeInstallIdentity,
	writeNativeInstallIdentity,
} from "./native-distribution";
import {
	isNativeTarget,
	MAX_NATIVE_MANIFEST_BYTES,
	NATIVE_RELEASE_MANIFEST_NAME,
	type NativeReleaseArtifact,
	type NativeTarget,
	parseNativeReleaseManifest,
} from "./native-release-manifest";
import {
	type PrivateDirectoryLockLease,
	type PrivateDirectoryLockOptions,
	withPrivateDirectoryLock,
} from "./private-directory-lock";
import { isValidSemver } from "./semver";

const REQUIRED_NATIVE_FILES = [
	"clawdi",
	"egress-addon/clawdi_egress_addon.py",
	"skills/clawdi/SKILL.md",
	"skills/hosted-versions/1/clawdi/SKILL.md",
] as const;
const MAX_NATIVE_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_NATIVE_ARCHIVE_ENTRIES = 20_000;
const MAX_NATIVE_ENTRY_BYTES = 200 * 1024 * 1024;
const MAX_NATIVE_UNPACKED_BYTES = 512 * 1024 * 1024;
const NATIVE_SMOKE_TIMEOUT_MS = 20_000;
const NATIVE_DOWNLOAD_TIMEOUT_MS = 3 * 60_000;
const NATIVE_STAGE_STALE_MS = 24 * 60 * 60 * 1000;

export interface StagedNativeRelease {
	stageDir: string;
	manifest: string;
	version: string;
	target: NativeTarget;
}

export function nativeIdentityOutput(): string {
	const identity = currentNativeCompiledIdentity();
	if (!identity) throw new Error("this invocation is not a native clawdi executable");
	return `${identity.version}\t${identity.target}`;
}

export async function downloadAndStageNativeRelease(input: {
	prefix: string;
	version: string;
	target: NativeTarget;
	releaseBaseUrl: string;
	signal?: AbortSignal;
	fetcher?: typeof fetch;
	timeoutMs?: number;
}): Promise<StagedNativeRelease> {
	if (!isAbsolute(input.prefix)) throw new Error("native install prefix must be absolute");
	const timeoutMs = input.timeoutMs ?? NATIVE_DOWNLOAD_TIMEOUT_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new Error("native download timeout must be positive");
	}
	const downloadAbort = new AbortController();
	const onAbort = () => downloadAbort.abort(input.signal?.reason);
	input.signal?.addEventListener("abort", onAbort, { once: true });
	if (input.signal?.aborted) {
		input.signal.removeEventListener("abort", onAbort);
		throw input.signal.reason ?? new Error("native release download aborted");
	}
	const timeout = setTimeout(
		() => downloadAbort.abort(new Error("native release download timed out")),
		timeoutMs,
	);
	const fetcher = input.fetcher ?? fetch;
	try {
		const manifestUrl = `${input.releaseBaseUrl}/${NATIVE_RELEASE_MANIFEST_NAME}`;
		const manifestResponse = await fetcher(manifestUrl, {
			signal: downloadAbort.signal,
			redirect: "follow",
		});
		if (!manifestResponse.ok) {
			throw new Error(`native manifest download failed (${manifestResponse.status})`);
		}
		const manifestText = new TextDecoder("utf-8", { fatal: true }).decode(
			await readBoundedResponse(manifestResponse, MAX_NATIVE_MANIFEST_BYTES, "native manifest"),
		);
		const manifest = parseNativeReleaseManifest(manifestText);
		if (manifest.version !== input.version) {
			throw new Error(
				`native manifest version mismatch: expected ${input.version}, got ${manifest.version}`,
			);
		}
		const artifact = manifest.artifacts.find((entry) => entry.target === input.target);
		if (!artifact) throw new Error(`native manifest does not support ${input.target}`);
		const artifactResponse = await fetcher(`${input.releaseBaseUrl}/${artifact.asset}`, {
			signal: downloadAbort.signal,
			redirect: "follow",
		});
		if (!artifactResponse.ok) {
			throw new Error(`native artifact download failed (${artifactResponse.status})`);
		}
		const archive = await readBoundedResponse(
			artifactResponse,
			MAX_NATIVE_ARCHIVE_BYTES,
			"native artifact",
		);
		verifyNativeArchiveChecksum(archive, artifact);
		await validateNativeArchive(archive);

		const nativeRoot = join(input.prefix, "share", "clawdi");
		mkdirSync(nativeRoot, { recursive: true, mode: 0o755 });
		const stageDir = mkdtempSync(join(nativeRoot, ".stage-"));
		try {
			await extractNativeArchive(stageDir, archive);
			validateStagedResources(stageDir);
			chmodSync(join(stageDir, "clawdi"), 0o755);
			writeFileSync(join(stageDir, NATIVE_RELEASE_MANIFEST_NAME), manifestText, { mode: 0o644 });
			return { stageDir, manifest: manifestText, version: input.version, target: input.target };
		} catch (error) {
			rmSync(stageDir, { recursive: true, force: true });
			throw error;
		}
	} finally {
		clearTimeout(timeout);
		input.signal?.removeEventListener("abort", onAbort);
	}
}

export async function activateStagedNativeRelease(
	input: { stageDir: string; prefix: string; version: string; target: NativeTarget },
	lockOptions?: PrivateDirectoryLockOptions,
): Promise<{ launcher: string; previousVersion: string | null }> {
	if (!evaluateHostPolicyForCommand("update").allowed) {
		throw new Error("native CLI activation is disabled by Hosted policy");
	}
	return await withPrivateDirectoryLock(
		join(getClawdiDir(), "update.lock"),
		async (lease) => activateStagedNativeReleaseWithLease(input, lease),
		lockOptions,
	);
}

async function activateStagedNativeReleaseWithLease(
	input: { stageDir: string; prefix: string; version: string; target: NativeTarget },
	lease: PrivateDirectoryLockLease,
): Promise<{ launcher: string; previousVersion: string | null }> {
	if (!isAbsolute(input.prefix) || !isAbsolute(input.stageDir)) {
		throw new Error("native activation paths must be absolute");
	}
	const compiled = currentNativeCompiledIdentity();
	if (!compiled || compiled.version !== input.version || compiled.target !== input.target) {
		throw new Error("native activation identity does not match the verified executable");
	}
	const prefix = resolve(input.prefix);
	const nativeRoot = join(prefix, "share", "clawdi");
	const versionsRoot = join(nativeRoot, "versions");
	const stageDir = resolve(input.stageDir);
	if (dirname(stageDir) !== nativeRoot || !stageDir.startsWith(`${nativeRoot}${sep}.stage-`)) {
		throw new Error("native stage must be a private child of the selected prefix");
	}
	const stagedExecutable = join(stageDir, "clawdi");
	if (realpathSync.native(process.execPath) !== realpathSync.native(stagedExecutable)) {
		throw new Error("native activation must run from the staged executable");
	}
	const manifestContent = validateVersionManifest(stageDir, compiled);
	validateStagedResources(stageDir);
	lease.assertOwned();
	writeNativeInstallIdentity(stageDir, compiled, manifestContent);
	lease.assertOwned();
	normalizeNativeTreeModes(stageDir);

	lease.assertOwned();
	mkdirSync(versionsRoot, { recursive: true, mode: 0o755 });
	const binDir = join(prefix, "bin");
	lease.assertOwned();
	mkdirSync(binDir, { recursive: true, mode: 0o755 });
	accessSync(binDir, constants.W_OK);
	const launcher = join(binDir, "clawdi");
	const previous = readOwnedLauncher(launcher, versionsRoot);

	const finalDir = join(versionsRoot, nativeVersionDirectoryName(input.version, input.target));
	const activeExecutable = join(finalDir, "clawdi");
	let installedNewDirectory = false;
	if (existsSync(finalDir)) {
		validateInstalledVersion(finalDir, compiled);
		lease.assertOwned();
		rmSync(stageDir, { recursive: true, force: true });
	} else {
		lease.assertOwned();
		renameSync(stageDir, finalDir);
		installedNewDirectory = true;
	}

	try {
		activateNativeLauncherTransaction(
			{
				launcher,
				active: { ...compiled, executable: activeExecutable },
				previous,
			},
			lease,
		);
	} catch (error) {
		if (installedNewDirectory) {
			lease.assertOwned();
			rmSync(finalDir, { recursive: true, force: true });
		}
		throw error;
	}
	lease.assertOwned();
	pruneNativeInstall(
		nativeRoot,
		versionsRoot,
		[activeExecutable, previous?.executable ?? null],
		lease,
	);
	return { launcher, previousVersion: previous?.version ?? null };
}

export function activateNativeLauncherTransaction(
	input: {
		launcher: string;
		active: NativeCompiledIdentity & { executable: string };
		previous: (NativeCompiledIdentity & { executable: string }) | null;
	},
	lease: PrivateDirectoryLockLease,
): void {
	lease.assertOwned();
	atomicLauncherSwap(input.launcher, input.active.executable);
	try {
		const activated = readNativeExecutableIdentity(input.launcher);
		if (activated?.version !== input.active.version || activated.target !== input.active.target) {
			throw new Error("activated native launcher failed version verification");
		}
	} catch (error) {
		lease.assertOwned();
		if (input.previous) {
			atomicLauncherSwap(input.launcher, input.previous.executable);
			const restored = readNativeExecutableIdentity(input.launcher);
			if (
				restored?.version !== input.previous.version ||
				restored.target !== input.previous.target
			) {
				throw new Error(
					`native activation failed and rollback verification also failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		} else {
			lease.assertOwned();
			rmSync(input.launcher, { force: true });
		}
		throw error;
	}
}

function readOwnedLauncher(
	launcher: string,
	versionsRoot: string,
): (NativeCompiledIdentity & { executable: string }) | null {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(launcher);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
	if (!stat.isSymbolicLink()) {
		throw new Error(`refusing to replace unowned executable at ${launcher}; move it first`);
	}
	let executable: string;
	try {
		executable = realpathSync.native(launcher);
	} catch (error) {
		throw new Error(
			`refusing to replace broken native launcher at ${launcher}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const relativeTarget = relative(versionsRoot, executable);
	if (
		!relativeTarget ||
		relativeTarget.startsWith("..") ||
		isAbsolute(relativeTarget) ||
		relativeTarget.split(sep).length !== 2 ||
		basename(executable) !== "clawdi"
	) {
		throw new Error(`refusing to replace unowned symlink at ${launcher}; move it first`);
	}
	const identity = readNativeExecutableIdentity(executable);
	if (!identity) throw new Error(`native launcher at ${launcher} has an invalid identity`);
	validateInstalledVersion(dirname(executable), identity);
	return { ...identity, executable };
}

function validateInstalledVersion(directory: string, identity: NativeCompiledIdentity): void {
	const manifestContent = validateVersionManifest(directory, identity);
	validateNativeInstallIdentity(directory, identity, manifestContent);
	validateStagedResources(directory);
	const actual = readNativeExecutableIdentity(join(directory, "clawdi"));
	if (!actual || actual.version !== identity.version || actual.target !== identity.target) {
		throw new Error(`native version directory has an invalid executable identity: ${directory}`);
	}
}

function validateVersionManifest(directory: string, identity: NativeCompiledIdentity): string {
	const path = join(directory, NATIVE_RELEASE_MANIFEST_NAME);
	const manifestFile = lstatSync(path);
	if (!manifestFile.isFile()) throw new Error("native version manifest is not a regular file");
	if (manifestFile.size > MAX_NATIVE_MANIFEST_BYTES) {
		throw new Error("native version manifest exceeds the size limit");
	}
	const content = readFileSync(path, "utf8");
	const manifest = parseNativeReleaseManifest(content);
	if (
		manifest.version !== identity.version ||
		!manifest.artifacts.some((artifact) => artifact.target === identity.target)
	) {
		throw new Error("native version manifest does not match executable identity");
	}
	return content;
}

function readNativeExecutableIdentity(command: string): NativeCompiledIdentity | null {
	const result = spawnSync(command, ["update", "--native-identity"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: NATIVE_SMOKE_TIMEOUT_MS,
	});
	if (result.status !== 0) return null;
	const fields = result.stdout.trim().split("\t");
	const [version, target] = fields;
	if (
		fields.length !== 2 ||
		!version ||
		!isValidSemver(version) ||
		!target ||
		!isNativeTarget(target)
	) {
		return null;
	}
	return { version, target };
}

function atomicLauncherSwap(launcher: string, target: string): void {
	const temporary = join(dirname(launcher), `.clawdi-${randomUUID()}`);
	try {
		symlinkSync(relative(dirname(launcher), target), temporary);
		renameSync(temporary, launcher);
	} finally {
		rmSync(temporary, { force: true });
	}
}

function verifyNativeArchiveChecksum(archive: Buffer, artifact: NativeReleaseArtifact): void {
	const actual = createHash("sha256").update(archive).digest("hex");
	if (actual !== artifact.sha256) throw new Error("native artifact checksum mismatch");
}

export async function validateNativeArchive(archive: Buffer): Promise<void> {
	const files = new Set<string>();
	const entries = new Set<string>();
	let unpackedBytes = 0;
	await streamTar(archive, "list", (path, type, size) => {
		assertAllowedNativeArchiveEntry(path, type, size);
		const normalized = normalizeArchivePath(path);
		if (entries.has(normalized))
			throw new Error(`native archive contains duplicate entry: ${path}`);
		entries.add(normalized);
		if (entries.size > MAX_NATIVE_ARCHIVE_ENTRIES) {
			throw new Error("native archive contains too many entries");
		}
		unpackedBytes += size;
		if (unpackedBytes > MAX_NATIVE_UNPACKED_BYTES) {
			throw new Error("native archive exceeds the unpacked size limit");
		}
		if (type === "File") files.add(normalized);
	});
	for (const required of REQUIRED_NATIVE_FILES) {
		if (!files.has(required)) throw new Error(`native archive is missing ${required}`);
	}
}

async function extractNativeArchive(directory: string, archive: Buffer): Promise<void> {
	let entries = 0;
	let unpackedBytes = 0;
	await streamTar(
		archive,
		"extract",
		(path, type, size) => {
			assertAllowedNativeArchiveEntry(path, type, size);
			entries += 1;
			unpackedBytes += size;
			if (entries > MAX_NATIVE_ARCHIVE_ENTRIES || unpackedBytes > MAX_NATIVE_UNPACKED_BYTES) {
				throw new Error("native archive exceeds extraction limits");
			}
		},
		directory,
	);
}

function streamTar(
	archive: Buffer,
	mode: "list" | "extract",
	onEntry: (path: string, type: string, size: number) => void,
	cwd?: string,
): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		const options = {
			gzip: true,
			...(cwd ? { cwd, preserveOwner: false } : {}),
			filter: (path: string, entry: { type?: string; size?: number }) => {
				onEntry(path, entry.type ?? "", entry.size ?? 0);
				return true;
			},
		};
		const stream = mode === "list" ? tar.list(options) : tar.extract(options);
		stream.on("close", resolvePromise);
		stream.on("error", reject);
		stream.end(archive);
	});
}

function assertAllowedNativeArchiveEntry(path: string, type: string, size: number): void {
	const normalized = normalizeArchivePath(path);
	const segments = normalized.split("/");
	if (
		!normalized ||
		path.startsWith("/") ||
		segments.some((segment) => segment === "" || segment === ".." || segment === ".") ||
		!(["clawdi", "egress-addon", "skills"] as string[]).includes(segments[0] ?? "") ||
		(type !== "File" && type !== "Directory")
	) {
		throw new Error(`native archive contains unsafe entry: ${path}`);
	}
	if (!Number.isSafeInteger(size) || size < 0 || size > MAX_NATIVE_ENTRY_BYTES) {
		throw new Error(`native archive entry exceeds the size limit: ${path}`);
	}
	if (segments[0] === "clawdi" && (segments.length !== 1 || type !== "File")) {
		throw new Error(`native archive contains unexpected executable entry: ${path}`);
	}
}

function pruneNativeInstall(
	nativeRoot: string,
	versionsRoot: string,
	keepExecutables: Array<string | null>,
	lease: PrivateDirectoryLockLease,
): void {
	const keepDirectories = new Set(
		keepExecutables.filter((path): path is string => path !== null).map((path) => dirname(path)),
	);
	for (const entry of readdirSync(versionsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const directory = join(versionsRoot, entry.name);
		if (keepDirectories.has(directory)) continue;
		const identity = readNativeExecutableIdentity(join(directory, "clawdi"));
		if (!identity) continue;
		try {
			validateInstalledVersion(directory, identity);
		} catch {
			continue;
		}
		lease.assertOwned();
		rmSync(directory, { recursive: true, force: true });
	}
	for (const entry of readdirSync(nativeRoot, { withFileTypes: true })) {
		if (!entry.name.startsWith(".stage-") || !entry.isDirectory()) continue;
		const directory = join(nativeRoot, entry.name);
		let observedMtime: number;
		try {
			observedMtime = statSync(directory).mtimeMs;
			if (Date.now() - observedMtime < NATIVE_STAGE_STALE_MS) continue;
		} catch {
			continue;
		}
		try {
			const identity = readNativeExecutableIdentity(join(directory, "clawdi"));
			if (!identity) continue;
			validateVersionManifest(directory, identity);
		} catch {
			continue;
		}
		lease.assertOwned();
		try {
			const currentMtime = statSync(directory).mtimeMs;
			if (currentMtime !== observedMtime || Date.now() - currentMtime < NATIVE_STAGE_STALE_MS) {
				continue;
			}
		} catch {
			continue;
		}
		lease.assertOwned();
		rmSync(directory, { recursive: true, force: true });
	}
}

function normalizeArchivePath(path: string): string {
	return path.replace(/^\.\//, "").replace(/\/$/, "");
}

function validateStagedResources(directory: string): void {
	for (const required of REQUIRED_NATIVE_FILES) {
		const path = join(directory, required);
		if (!lstatSync(path).isFile())
			throw new Error(`native release resource is missing: ${required}`);
	}
	assertTreeHasNoLinks(join(directory, "egress-addon"));
	assertTreeHasNoLinks(join(directory, "skills"));
}

function normalizeNativeTreeModes(directory: string, root = directory): void {
	chmodSync(directory, 0o755);
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isSymbolicLink())
			throw new Error(`native release resource contains a symlink: ${path}`);
		if (entry.isDirectory()) normalizeNativeTreeModes(path, root);
		else if (entry.isFile()) chmodSync(path, path === join(root, "clawdi") ? 0o755 : 0o644);
		else throw new Error(`native release resource has an unsupported type: ${path}`);
	}
}

function assertTreeHasNoLinks(directory: string): void {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isSymbolicLink())
			throw new Error(`native release resource contains a symlink: ${path}`);
		if (entry.isDirectory()) assertTreeHasNoLinks(path);
		else if (!entry.isFile())
			throw new Error(`native release resource has an unsupported type: ${path}`);
	}
}

async function readBoundedResponse(
	response: Response,
	maximumBytes: number,
	label: string,
): Promise<Buffer> {
	const declaredLength = response.headers.get("content-length");
	if (declaredLength !== null) {
		const parsed = Number(declaredLength);
		if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximumBytes) {
			throw new Error(`${label} exceeds the maximum allowed size`);
		}
	}
	if (!response.body) throw new Error(`${label} response has no body`);
	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maximumBytes) throw new Error(`${label} exceeds the maximum allowed size`);
			chunks.push(Buffer.from(value));
		}
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		throw error;
	}
	return Buffer.concat(chunks, total);
}
