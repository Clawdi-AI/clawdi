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
import { runtimeContentSha256 } from "./applied-state";
import {
	ensureFileBrowserServiceIsolation,
	type FileBrowserServiceIdentity,
	type FileBrowserServiceIsolation,
} from "./file-browser-isolation";
import type { RuntimeInstallReceiptEntry } from "./install-receipts";
import type { RuntimeManifest } from "./manifest-contract";
import type { RuntimePaths } from "./paths";
import type { RuntimeSystemdUserProgram } from "./runtime-systemd-reconciliation";
import { runningAsRoot } from "./runtime-user-command";
import { writeRuntimePlatformFileAtomic } from "./state";

const FILE_BROWSER_BINARY = "filebrowser";
const FILE_BROWSER_CANDIDATES = "candidates";
const FILE_BROWSER_RECEIPT = "filebrowser";

type FileBrowserCompanion = NonNullable<NonNullable<RuntimeManifest["companions"]>["filebrowser"]>;
type FileBrowserAsset = FileBrowserCompanion["assets"][keyof FileBrowserCompanion["assets"]];

export interface FileBrowserInstallReceiptTarget {
	desiredRevision: string;
	currentRevision: () => string | null;
	expectedCurrentRevision: string | null;
}

export interface FileBrowserCompanionInstallOptions {
	arch?: NodeJS.Architecture;
	download?: (url: string, destination: string) => void;
	serviceIsolation?: FileBrowserServiceIsolation;
	versionProbe?: (binary: string) => string;
}

export interface FileBrowserCompanionInstallResult {
	receiptKey: typeof FILE_BROWSER_RECEIPT;
	receiptTarget: FileBrowserInstallReceiptTarget;
	activeBinary: string;
	installed: boolean;
}

export interface FileBrowserCompanionMutationPlan {
	rootTrustedRoots: string[];
	rootTargets: string[];
}

function fileBrowser(manifest: RuntimeManifest): FileBrowserCompanion | null {
	return manifest.companions?.filebrowser ?? null;
}

function candidatesRoot(paths: RuntimePaths): string {
	return join(paths.fileBrowserInstallRoot, FILE_BROWSER_CANDIDATES);
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
		const owner = managedRootIdentity();
		if (root.uid !== owner.uid || root.gid !== owner.gid || (root.mode & 0o777) !== 0o755) {
			return false;
		}
	} catch {
		return false;
	}
	try {
		const binary = lstatSync(candidateBinary(paths, sha256));
		const owner = managedRootIdentity();
		return (
			binary.isFile() &&
			!binary.isSymbolicLink() &&
			binary.uid === owner.uid &&
			binary.gid === owner.gid &&
			(binary.mode & 0o777) === 0o755 &&
			sha256File(candidateBinary(paths, sha256)) === sha256.toLowerCase()
		);
	} catch {
		return false;
	}
}

export function fileBrowserCompanionMutationPlan(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	arch: NodeJS.Architecture = process.arch,
): FileBrowserCompanionMutationPlan {
	const companion = fileBrowser(manifest);
	if (!companion) {
		return {
			rootTrustedRoots: [],
			rootTargets: [],
		};
	}
	const asset = selectedAsset(companion, arch);
	const target = candidateRoot(paths, asset.sha256);
	return {
		rootTrustedRoots: [paths.fileBrowserInstallRoot],
		rootTargets: [
			...(candidateIsValid(paths, asset.sha256) ? [] : [target]),
			paths.fileBrowserConfig,
		],
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

function managedRootIdentity(): FileBrowserServiceIdentity {
	if (runningAsRoot()) return { uid: 0, gid: 0 };
	return {
		uid: typeof process.geteuid === "function" ? process.geteuid() : 0,
		gid: typeof process.getegid === "function" ? process.getegid() : 0,
	};
}

function ensureOwnedDirectory(
	path: string,
	identity: FileBrowserServiceIdentity,
	mode: number,
): void {
	if (!existsSync(path)) mkdirSync(path, { recursive: true, mode });
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error(`Files companion managed path is not a trusted directory: ${path}`);
	}
	chownSync(path, identity.uid, identity.gid);
	chmodSync(path, mode);
}

function defaultDownload(url: string, destination: string, paths: RuntimePaths): void {
	const result = spawnSync(
		"curl",
		["-fsSL", "--proto", "=https", "--tlsv1.2", "--retry", "3", "-o", destination, url],
		{
			cwd: paths.fileBrowserInstallRoot,
			encoding: "utf8",
			maxBuffer: 64 * 1024,
			timeout: 300_000,
		},
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

function installCandidate(
	companion: NonNullable<FileBrowserCompanion>,
	paths: RuntimePaths,
	asset: FileBrowserAsset,
	options: FileBrowserCompanionInstallOptions,
): void {
	const targetRoot = candidateRoot(paths, asset.sha256);
	if (candidateIsValid(paths, asset.sha256)) return;
	rmSync(targetRoot, { recursive: true, force: true });
	const staging = mkdtempSync(join(candidatesRoot(paths), ".staging-"));
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
		chmodSync(binary, 0o755);
		chownSync(binary, managedRootIdentity().uid, managedRootIdentity().gid);
		chmodSync(staging, 0o755);
		if (options.versionProbe) {
			const version = options.versionProbe(binary);
			if (!version.includes(companion.version) || !version.includes(companion.commit.slice(0, 7))) {
				throw new Error("Files companion version probe did not match the pinned release");
			}
		}
		renameSync(staging, targetRoot);
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

function cleanStaleStaging(paths: RuntimePaths): string[] {
	const removed: string[] = [];
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
	return removed;
}

function desiredRevision(companion: NonNullable<FileBrowserCompanion>, config: string): string {
	return runtimeContentSha256({
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
		const configStat = lstatSync(paths.fileBrowserConfig);
		if (!configStat.isFile() || configStat.isSymbolicLink()) return null;
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
	(options.serviceIsolation ?? ensureFileBrowserServiceIsolation)(paths, companion.sourceRoot);
	ensureOwnedDirectory(paths.fileBrowserInstallRoot, managedRootIdentity(), 0o755);
	ensureOwnedDirectory(candidatesRoot(paths), managedRootIdentity(), 0o755);
	cleanStaleStaging(paths);
	if (!verifiedReceipt || before === null) {
		installCandidate(companion, paths, asset, options);
		writeRuntimePlatformFileAtomic(paths, paths.fileBrowserConfig, config, {
			mode: 0o600,
			dirMode: 0o700,
		});
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
	return removed;
}
