import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	chownSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
} from "node:fs";
import { basename, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { writePrivateFileAtomic } from "../lib/private-file";
import { runtimeContentSha256 } from "./applied-state";
import type { RuntimeInstallReceiptEntry } from "./install-receipts";
import type { RuntimeManifest } from "./manifest-contract";
import type { RuntimePaths } from "./paths";
import type { RuntimeSystemdUserProgram } from "./runtime-systemd-reconciliation";
import {
	makeRuntimeUserOwned,
	runningAsRoot,
	runtimeUserGid,
	runtimeUserUid,
	spawnRuntimeUserCommand,
	withRuntimeUserFileAccess,
} from "./runtime-user-command";

const FILE_BROWSER_BINARY = "filebrowser";
const FILE_BROWSER_CANDIDATES = "candidates";
const FILE_BROWSER_RECEIPT = "files";

type FileBrowserCompanion = NonNullable<NonNullable<RuntimeManifest["companions"]>["files"]>;
type FileBrowserAsset = FileBrowserCompanion["assets"][keyof FileBrowserCompanion["assets"]];

export interface FileBrowserInstallReceiptTarget {
	desiredRevision: string;
	currentRevision: () => string | null;
	expectedCurrentRevision: string | null;
}

export interface FileBrowserCompanionInstallOptions {
	arch?: NodeJS.Architecture;
	download?: (url: string, destination: string) => void;
	versionProbe?: (binary: string) => string;
}

export interface FileBrowserCompanionInstallResult {
	receiptKey: typeof FILE_BROWSER_RECEIPT;
	receiptTarget: FileBrowserInstallReceiptTarget;
	activeBinary: string;
	installed: boolean;
}

export interface FileBrowserCompanionMutationPlan {
	runtimeUserTargets: string[];
	runtimeUserTrustedRoots: string[];
	runtimeUserSymlinkTargets: string[];
	rootTargets: string[];
}

function fileBrowser(manifest: RuntimeManifest): FileBrowserCompanion | null {
	return manifest.companions?.files ?? null;
}

function candidatesRoot(paths: RuntimePaths): string {
	return join(paths.companionInstallRoot, FILE_BROWSER_CANDIDATES);
}

function candidateRoot(paths: RuntimePaths, sha256: string): string {
	return join(candidatesRoot(paths), sha256.toLowerCase());
}

function candidateBinary(paths: RuntimePaths, sha256: string): string {
	return join(candidateRoot(paths, sha256), FILE_BROWSER_BINARY);
}

function selectedAsset(
	companion: NonNullable<FileBrowserCompanion>,
	arch: NodeJS.Architecture,
): FileBrowserAsset {
	if (arch === "x64") return companion.assets.amd64;
	if (arch === "arm64") return companion.assets.arm64;
	throw new Error(`Files companion does not support runtime architecture ${arch}`);
}

function sha256File(path: string): string | null {
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink()) return null;
		return createHash("sha256").update(readFileSync(path)).digest("hex");
	} catch {
		return null;
	}
}

function candidateIsValid(paths: RuntimePaths, sha256: string): boolean {
	try {
		const root = lstatSync(candidateRoot(paths, sha256));
		if (!root.isDirectory() || root.isSymbolicLink()) return false;
	} catch {
		return false;
	}
	return sha256File(candidateBinary(paths, sha256)) === sha256.toLowerCase();
}

export function fileBrowserCompanionMutationPlan(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	arch: NodeJS.Architecture = process.arch,
): FileBrowserCompanionMutationPlan {
	const companion = fileBrowser(manifest);
	if (!companion) {
		return {
			runtimeUserTargets: [],
			runtimeUserTrustedRoots: [],
			runtimeUserSymlinkTargets: [],
			rootTargets: [],
		};
	}
	const asset = selectedAsset(companion, arch);
	const target = candidateRoot(paths, asset.sha256);
	return {
		runtimeUserTargets: [
			...(candidateIsValid(paths, asset.sha256) ? [] : [target]),
			...(existsSync(paths.fileBrowserStateRoot) ? [] : [paths.fileBrowserStateRoot]),
			...(existsSync(paths.fileBrowserStateRoot) &&
			existsSync(join(paths.fileBrowserStateRoot, "cache"))
				? []
				: existsSync(paths.fileBrowserStateRoot)
					? [join(paths.fileBrowserStateRoot, "cache")]
					: []),
		],
		runtimeUserTrustedRoots: [paths.companionInstallRoot, paths.fileBrowserStateRoot],
		runtimeUserSymlinkTargets: [],
		rootTargets: [paths.fileBrowserConfig],
	};
}

function renderFileBrowserConfig(
	companion: NonNullable<FileBrowserCompanion>,
	paths: RuntimePaths,
): string {
	return stringifyYaml({
		server: {
			listen: companion.listen,
			port: companion.port,
			baseURL: companion.baseURL,
			database: join(paths.fileBrowserStateRoot, "filebrowser.db"),
			cacheDir: join(paths.fileBrowserStateRoot, "cache"),
			disableUpdateCheck: true,
			disableWebDAV: true,
			sources: [
				{
					path: companion.sourceRoot,
					name: "Files",
					config: {
						defaultEnabled: true,
						private: true,
						rules: [{ folderPath: "/", ignoreHidden: true, ignoreSymlinks: true }],
					},
				},
			],
		},
		frontend: {
			name: "Files",
			disableDefaultLinks: true,
			disableUsedPercentage: false,
		},
		http: { trustedHeaders: [] },
		auth: {
			methods: {
				password: { enabled: false, signup: false },
				passkey: { enabled: false },
				jwt: {
					enabled: true,
					secret: companion.auth.secret,
					algorithm: companion.auth.algorithm,
					header: companion.auth.header,
					userIdentifier: companion.auth.userIdentifier,
					groupsClaim: companion.auth.groupsClaim,
					userGroups: [companion.auth.requiredGroup],
				},
			},
		},
		userDefaults: {
			account: {
				lockPassword: true,
				disableSettings: true,
				disableUpdateNotifications: true,
				loginMethod: "jwt",
				permissions: {
					admin: false,
					api: false,
					modify: true,
					share: false,
					realtime: false,
					delete: true,
					create: true,
					download: true,
				},
			},
		},
	});
}

function expectedRuntimeUserIdentity(): { uid: number; gid: number } | null {
	const runtimeUser = process.env.CLAWDI_RUNTIME_USER?.trim();
	if (runningAsRoot() && runtimeUser && runtimeUser !== "root" && runtimeUser !== "0") {
		return { uid: runtimeUserUid(runtimeUser), gid: runtimeUserGid(runtimeUser) };
	}
	if (typeof process.geteuid !== "function" || typeof process.getegid !== "function") return null;
	return { uid: process.geteuid(), gid: process.getegid() };
}

function assertRuntimeUserDirectory(path: string): void {
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error(`Files companion runtime path is not a trusted directory: ${path}`);
	}
	if ((stat.mode & 0o777) !== 0o700) {
		throw new Error(`Files companion runtime directory is not private: ${path}`);
	}
	const identity = expectedRuntimeUserIdentity();
	if (identity && (stat.uid !== identity.uid || stat.gid !== identity.gid)) {
		throw new Error(`Files companion runtime directory has an unexpected owner: ${path}`);
	}
	if (identity && (identity.uid === 0 || identity.gid === 0)) {
		throw new Error("Files companion must not install as a root filesystem identity");
	}
}

function ensureRuntimeUserDirectory(path: string): void {
	if (!existsSync(path)) {
		mkdirSync(path, { recursive: true, mode: 0o700 });
		chmodSync(path, 0o700);
		makeRuntimeUserOwned(path);
	}
	assertRuntimeUserDirectory(path);
}

function makeConfigReadableByRuntime(path: string): void {
	chmodSync(path, 0o640);
	if (runningAsRoot()) {
		chownSync(path, 0, runtimeUserGid(process.env.CLAWDI_RUNTIME_USER || "clawdi"));
	}
}

function defaultDownload(url: string, destination: string, paths: RuntimePaths): void {
	const result = spawnRuntimeUserCommand(
		"curl",
		["-fsSL", "--proto", "=https", "--tlsv1.2", "--retry", "3", "-o", destination, url],
		paths.userHome,
		paths.companionInstallRoot,
		{ timeoutMs: 300_000, maxBufferBytes: 64 * 1024 },
	);
	if (result.status !== 0) {
		const detail = [result.stderr, result.stdout]
			.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
			.join("\n")
			.trim()
			.slice(-2000);
		throw new Error(`Files companion download failed${detail ? `: ${detail}` : ""}`);
	}
}

function defaultVersionProbe(binary: string, paths: RuntimePaths): string {
	const result = spawnRuntimeUserCommand(binary, ["version"], paths.userHome, paths.userHome, {
		timeoutMs: 10_000,
		maxBufferBytes: 64 * 1024,
	});
	if (result.status !== 0) throw new Error("Files companion version probe failed");
	return [result.stdout, result.stderr]
		.filter((value): value is string => typeof value === "string")
		.join("\n");
}

function installCandidate(
	companion: NonNullable<FileBrowserCompanion>,
	paths: RuntimePaths,
	asset: FileBrowserAsset,
	options: FileBrowserCompanionInstallOptions,
): void {
	const targetRoot = candidateRoot(paths, asset.sha256);
	if (candidateIsValid(paths, asset.sha256)) return;
	withRuntimeUserFileAccess(() => rmSync(targetRoot, { recursive: true, force: true }));
	const staging = withRuntimeUserFileAccess(() =>
		mkdtempSync(join(candidatesRoot(paths), ".staging-")),
	);
	try {
		const binary = join(staging, FILE_BROWSER_BINARY);
		if (options.download) options.download(asset.url, binary);
		else defaultDownload(asset.url, binary, paths);
		const actualSha256 = sha256File(binary);
		if (actualSha256 !== asset.sha256.toLowerCase()) {
			throw new Error(
				`Files companion SHA256 mismatch: expected ${asset.sha256.toLowerCase()}, got ${actualSha256 ?? "unreadable"}`,
			);
		}
		withRuntimeUserFileAccess(() => chmodSync(binary, 0o755));
		const version = options.versionProbe
			? options.versionProbe(binary)
			: defaultVersionProbe(binary, paths);
		if (!version.includes(companion.version) || !version.includes(companion.commit.slice(0, 7))) {
			throw new Error("Files companion version probe did not match the pinned release");
		}
		withRuntimeUserFileAccess(() => renameSync(staging, targetRoot));
	} finally {
		withRuntimeUserFileAccess(() => rmSync(staging, { recursive: true, force: true }));
	}
}

function cleanStaleStaging(paths: RuntimePaths): string[] {
	const removed: string[] = [];
	withRuntimeUserFileAccess(() => {
		for (const entry of readdirSync(candidatesRoot(paths)).sort()) {
			if (!entry.startsWith(".staging-")) continue;
			const path = join(candidatesRoot(paths), entry);
			const stat = lstatSync(path);
			if (!stat.isDirectory() || stat.isSymbolicLink()) {
				throw new Error(`Files companion staging entry is not a trusted directory: ${entry}`);
			}
			rmSync(path, { recursive: true });
			removed.push(path);
		}
	});
	return removed;
}

function desiredRevision(companion: NonNullable<FileBrowserCompanion>, config: string): string {
	return runtimeContentSha256({
		kind: companion.kind,
		version: companion.version,
		commit: companion.commit,
		assets: companion.assets,
		config,
	});
}

function currentRevision(
	companion: NonNullable<FileBrowserCompanion>,
	paths: RuntimePaths,
	assetSha256: string,
	config: string,
): string | null {
	if (!candidateIsValid(paths, assetSha256)) return null;
	try {
		if (readFileSync(paths.fileBrowserConfig, "utf8") !== config) return null;
	} catch {
		return null;
	}
	return desiredRevision(companion, config);
}

export function ensureFileBrowserCompanion(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	previousReceipt: RuntimeInstallReceiptEntry | undefined,
	options: FileBrowserCompanionInstallOptions = {},
): FileBrowserCompanionInstallResult | null {
	const companion = fileBrowser(manifest);
	if (!companion) return null;
	const asset = selectedAsset(companion, options.arch ?? process.arch);
	const config = renderFileBrowserConfig(companion, paths);
	const desired = desiredRevision(companion, config);
	const before = currentRevision(companion, paths, asset.sha256, config);
	const candidateWasValid = candidateIsValid(paths, asset.sha256);
	const verifiedReceipt =
		previousReceipt?.desiredRevision === desired && previousReceipt.currentRevision === before;
	ensureRuntimeUserDirectory(paths.companionInstallRoot);
	ensureRuntimeUserDirectory(candidatesRoot(paths));
	cleanStaleStaging(paths);
	ensureRuntimeUserDirectory(paths.fileBrowserStateRoot);
	ensureRuntimeUserDirectory(join(paths.fileBrowserStateRoot, "cache"));
	if (!verifiedReceipt || before === null) {
		installCandidate(companion, paths, asset, options);
		writePrivateFileAtomic(paths.fileBrowserConfig, config, { mode: 0o640, dirMode: 0o755 });
		makeConfigReadableByRuntime(paths.fileBrowserConfig);
	}
	const current = () => currentRevision(companion, paths, asset.sha256, config);
	const expected = current();
	if (expected !== desired)
		throw new Error("Files companion candidate did not pass activation verification");
	return {
		receiptKey: FILE_BROWSER_RECEIPT,
		receiptTarget: {
			desiredRevision: desired,
			currentRevision: current,
			expectedCurrentRevision: expected,
		},
		activeBinary: candidateBinary(paths, asset.sha256),
		installed: !candidateWasValid,
	};
}

export function fileBrowserCompanionProgram(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
): RuntimeSystemdUserProgram | null {
	const companion = fileBrowser(manifest);
	if (!companion) return null;
	const asset = selectedAsset(companion, process.arch);
	return {
		programKind: "file-browser",
		runtime: "files",
		service: null,
		command: candidateBinary(paths, asset.sha256),
		args: ["-c", paths.fileBrowserConfig],
		cwd: companion.sourceRoot,
		env: {},
		resolvedSecretEnv: {},
	};
}

export function probeFileBrowserReadiness(
	manifest: RuntimeManifest,
	options: { probe?: (url: string) => boolean } = {},
): void {
	const companion = fileBrowser(manifest);
	if (!companion) return;
	const url = `http://127.0.0.1:${companion.port}${companion.healthPath}`;
	const ready = options.probe
		? options.probe(url)
		: spawnSync(
				"curl",
				[
					"-fsS",
					"--retry",
					"5",
					"--retry-connrefused",
					"--retry-delay",
					"1",
					"--max-time",
					"2",
					url,
				],
				{ encoding: "utf8", timeout: 12_000 },
			).status === 0;
	if (!ready) throw new Error(`Files companion readiness failed at ${url}`);
}

export function gcFileBrowserCompanionCandidates(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	arch: NodeJS.Architecture = process.arch,
): string[] {
	const companion = fileBrowser(manifest);
	if (!companion || !existsSync(candidatesRoot(paths))) return [];
	const retained = candidateRoot(paths, selectedAsset(companion, arch).sha256);
	const removed: string[] = [];
	withRuntimeUserFileAccess(() => {
		for (const entry of readdirSync(candidatesRoot(paths)).sort()) {
			const path = join(candidatesRoot(paths), entry);
			if (path === retained) continue;
			const stat = lstatSync(path);
			if (!stat.isDirectory() || stat.isSymbolicLink()) {
				throw new Error(`Files companion candidate is not a trusted directory: ${basename(path)}`);
			}
			rmSync(path, { recursive: true });
			removed.push(path);
		}
	});
	return removed;
}
