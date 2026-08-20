import {
	chmodSync,
	chownSync,
	existsSync,
	lchownSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { runtimeInstallReceiptsPath } from "./install-receipts";
import type { RuntimeManifest } from "./manifest-contract";
import type { RuntimePaths } from "./paths";
import { runningAsRoot } from "./runtime-user-command";
import { isGeneratedRuntimeSystemdFile } from "./systemd-user";

type RuntimeLiveSnapshotNode =
	| { kind: "missing" }
	| { kind: "metadata"; existed: false }
	| { kind: "metadata"; existed: true; mode: number; uid: number; gid: number }
	| { kind: "file"; content: Buffer; mode: number; uid: number; gid: number }
	| { kind: "symlink"; target: string; uid: number; gid: number }
	| {
			kind: "directory";
			mode: number;
			uid: number;
			gid: number;
			entries: Map<string, RuntimeLiveSnapshotNode>;
	  };

export interface RuntimeLiveSnapshot {
	entries: Map<string, RuntimeLiveSnapshotNode>;
}

export interface RuntimeManagedMutationPlan {
	rootTargets: string[];
	trustedRootDirectories: string[];
	runtimeUserTargets: string[];
	runtimeUserTrustedRoots: string[];
	runtimeUserSymlinkTargets: string[];
	metadataTargets: string[];
}

export function runtimeRootLiveMutationTargets(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
): string[] {
	const result = new Set<string>([
		paths.managedConfig,
		paths.syncState,
		paths.providerHealthStatus,
		paths.egressEngineStatus,
		paths.manifestLastGood,
		paths.managedSecretCacheFile,
		paths.appliedState,
		paths.oauthCredentialRoot,
		runtimeInstallReceiptsPath(paths),
		paths.runConfigRoot,
		paths.egressProfileBundle,
		paths.installInventory,
		paths.managedResourceRoot,
		paths.projectionRoot,
		join(paths.instanceRoot, manifest.instanceId),
		paths.daemonAuthToken,
		join(paths.managedSecretRoot, "egress-secrets.json"),
		paths.instanceData,
		paths.sensitiveInstanceData,
		paths.egressAddon,
		paths.egressTransparentEnv,
		paths.egressSystemCaFile,
		paths.liveSyncEnvironmentIndex,
	]);
	for (const name of ["clawdi-runtime-watch", "clawdi-daemon", "clawdi-runtime-sidecar"]) {
		const unitName = `${name}.service`;
		result.add(join(paths.systemdSystemRoot, unitName));
		result.add(join(paths.systemdEnvRoot, `${unitName}.env`));
	}
	if (manifest.companions?.filebrowser) {
		result.add(join(paths.systemdSystemRoot, "clawdi-files.service"));
		result.add(join(paths.systemdEnvRoot, "clawdi-files.service.env"));
	}
	addExistingManagedSystemdSystemPaths(paths, result);
	return [...result].sort();
}

export function runtimeLiveSnapshotPaths(plan: RuntimeManagedMutationPlan): string[] {
	return [...new Set([...plan.rootTargets, ...plan.runtimeUserTargets])].sort();
}

export function captureRuntimeLiveSnapshot(plan: RuntimeManagedMutationPlan): RuntimeLiveSnapshot {
	assertRuntimeUserMutationPathsTrusted(
		plan.runtimeUserTargets,
		plan.runtimeUserTrustedRoots,
		plan.runtimeUserSymlinkTargets,
	);
	const rootTargets = [...new Set(plan.rootTargets)].sort();
	for (const path of plan.trustedRootDirectories) assertRuntimeManagedDirectoryTrusted(path);
	const runtimeUserTargets = [...new Set(plan.runtimeUserTargets)].sort();
	const duplicate = rootTargets.find((path) => runtimeUserTargets.includes(path));
	if (duplicate) throw new Error(`runtime mutation target has multiple owners: ${duplicate}`);
	const snapshotPaths = [...rootTargets, ...runtimeUserTargets].sort();
	for (const [index, path] of snapshotPaths.entries()) {
		const nested = snapshotPaths
			.slice(index + 1)
			.find((candidate) => candidate.startsWith(`${path}/`));
		if (nested) throw new Error(`runtime mutation targets overlap: ${path} and ${nested}`);
	}
	const metadataTargets = [
		...new Set([...plan.metadataTargets, ...runtimeLiveSnapshotMetadataPaths(snapshotPaths)]),
	].sort();
	const metadataOverlap = metadataTargets.find((path) => snapshotPaths.includes(path));
	if (metadataOverlap) {
		throw new Error(`runtime mutation target also used as metadata target: ${metadataOverlap}`);
	}
	return {
		entries: new Map([
			...rootTargets.map((path) => [path, captureRuntimeLiveNode(path, true)] as const),
			...runtimeUserTargets.map((path) => [path, captureRuntimeLiveNode(path, false)] as const),
			...metadataTargets.map((path) => [path, captureRuntimeLiveMetadata(path)] as const),
		]),
	};
}

function assertRuntimeUserMutationPathsTrusted(
	targets: string[],
	roots: string[],
	symlinkTargets: string[],
): void {
	const trustedRoots = [...new Set(roots.map((root) => resolve(root)))].sort(
		(left, right) => right.length - left.length,
	);
	const resolvedTargets = [...new Set(targets.map((path) => resolve(path)))].sort();
	const allowedSymlinkTargets = new Set(symlinkTargets.map((path) => resolve(path)));
	for (const target of allowedSymlinkTargets) {
		if (!resolvedTargets.includes(target)) {
			throw new Error(`runtime-user symlink target is not a mutation target: ${target}`);
		}
	}
	for (const target of resolvedTargets) {
		const boundary = trustedRoots.find((root) => {
			const candidate = relative(root, target);
			return candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate));
		});
		if (!boundary) {
			throw new Error(`runtime-user mutation target is outside trusted roots: ${target}`);
		}
		let current = target;
		while (true) {
			try {
				const stat = lstatSync(current);
				if (stat.isSymbolicLink() && (current !== target || !allowedSymlinkTargets.has(target))) {
					throw new Error(`runtime-user mutation path contains a symlink: ${current}`);
				}
				if (current !== target && !stat.isDirectory()) {
					throw new Error(`runtime-user mutation ancestor is not a directory: ${current}`);
				}
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			}
			if (current === boundary) break;
			const parent = dirname(current);
			if (parent === current) {
				throw new Error(`runtime-user mutation target has no trusted boundary: ${target}`);
			}
			current = parent;
		}
	}
}

export function runtimeRootLiveMutationDirectories(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
): string[] {
	return [
		paths.runConfigRoot,
		paths.systemdEnvRoot,
		paths.installInventory,
		paths.oauthCredentialRoot,
		paths.managedResourceRoot,
		paths.projectionRoot,
		join(paths.instanceRoot, manifest.instanceId),
	];
}

function assertRuntimeManagedDirectoryTrusted(path: string): void {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error(`runtime managed directory is not a real directory: ${path}`);
	}
	if ((stat.mode & 0o022) !== 0 && !hasPrivateOwnedAncestor(path)) {
		throw new Error(`runtime managed directory is group/world writable: ${path}`);
	}
	if (runningAsRoot() && stat.uid !== 0) {
		throw new Error(`runtime managed directory is not root-owned: ${path}`);
	}
}

function hasPrivateOwnedAncestor(path: string): boolean {
	const expectedUid = process.geteuid?.() ?? process.getuid?.();
	let current = dirname(resolve(path));
	for (;;) {
		const node = lstatSync(current);
		if (node.isSymbolicLink() || !node.isDirectory()) return false;
		if (node.uid === expectedUid && (node.mode & 0o077) === 0) return true;
		const parent = dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

export function restoreRuntimeLiveSnapshot(snapshot: RuntimeLiveSnapshot): void {
	for (const [path, node] of snapshot.entries) {
		if (node.kind !== "metadata") restoreRuntimeLiveNode(path, node);
	}
	const metadataEntries = [...snapshot.entries].filter(
		(entry): entry is [string, Extract<RuntimeLiveSnapshotNode, { kind: "metadata" }>] =>
			entry[1].kind === "metadata",
	);
	for (const [path, node] of metadataEntries
		.filter(([, node]) => node.existed)
		.sort(([left], [right]) => left.length - right.length)) {
		restoreRuntimeLiveNode(path, node);
	}
	for (const [path, node] of metadataEntries
		.filter(([, node]) => !node.existed)
		.sort(([left], [right]) => right.length - left.length)) {
		restoreRuntimeLiveNode(path, node);
	}
}

function addExistingManagedSystemdSystemPaths(paths: RuntimePaths, result: Set<string>): void {
	if (!existsSync(paths.systemdSystemRoot)) return;
	for (const entry of readdirSync(paths.systemdSystemRoot)) {
		const path = join(paths.systemdSystemRoot, entry);
		if (
			entry.endsWith(".service") &&
			(entry.startsWith("clawdi-") || isGeneratedSystemdFile(path))
		) {
			result.add(path);
		}
		if (!entry.endsWith(".service.d")) continue;
		const dropIn = join(path, "10-clawdi-hosted.conf");
		if (isGeneratedSystemdFile(dropIn)) result.add(dropIn);
	}
}

function isGeneratedSystemdFile(path: string): boolean {
	try {
		return isGeneratedRuntimeSystemdFile(readFileSync(path, "utf-8"));
	} catch {
		return false;
	}
}

function runtimeLiveSnapshotMetadataPaths(snapshotPaths: readonly string[]): string[] {
	return [
		...new Set(
			snapshotPaths
				.filter((path) => basename(path) === "10-clawdi-hosted.conf")
				.map((path) => dirname(path)),
		),
	].sort();
}

function captureRuntimeLiveNode(path: string, requireRootOwner: boolean): RuntimeLiveSnapshotNode {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
		throw error;
	}
	if (stat.isSymbolicLink()) {
		return { kind: "symlink", target: readlinkSync(path), uid: stat.uid, gid: stat.gid };
	}
	if (stat.isFile()) {
		return {
			kind: "file",
			content: readFileSync(path),
			mode: stat.mode & 0o777,
			uid: stat.uid,
			gid: stat.gid,
		};
	}
	if (!stat.isDirectory()) throw new Error(`unsupported runtime live-state path: ${path}`);
	const mode = stat.mode & 0o777;
	if (requireRootOwner && (mode & 0o022) !== 0 && !hasPrivateOwnedAncestor(path)) {
		throw new Error(`runtime live-state snapshot directory is group/world writable: ${path}`);
	}
	if (requireRootOwner && runningAsRoot() && stat.uid !== 0) {
		throw new Error(`runtime live-state snapshot directory is not root-owned: ${path}`);
	}
	return {
		kind: "directory",
		mode,
		uid: stat.uid,
		gid: stat.gid,
		entries: new Map(
			readdirSync(path)
				.sort()
				.map((entry) => [entry, captureRuntimeLiveNode(join(path, entry), requireRootOwner)]),
		),
	};
}

function captureRuntimeLiveMetadata(path: string): RuntimeLiveSnapshotNode {
	try {
		const stat = lstatSync(path);
		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			throw new Error(`runtime mutation metadata target is not a real directory: ${path}`);
		}
		return {
			kind: "metadata",
			existed: true,
			mode: stat.mode & 0o777,
			uid: stat.uid,
			gid: stat.gid,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { kind: "metadata", existed: false };
		}
		throw error;
	}
}

function restoreRuntimeLiveOwnership(
	path: string,
	uid: number,
	gid: number,
	symlink: boolean,
): void {
	const restored = lstatSync(path);
	if (restored.uid === uid && restored.gid === gid) return;
	if (symlink) lchownSync(path, uid, gid);
	else chownSync(path, uid, gid);
}

function restoreRuntimeLiveNode(path: string, node: RuntimeLiveSnapshotNode): void {
	if (node.kind === "metadata") {
		if (!node.existed) {
			if (existsSync(path) && readdirSync(path).length === 0) rmSync(path, { recursive: true });
			return;
		}
		if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: node.mode });
		chmodSync(path, node.mode);
		restoreRuntimeLiveOwnership(path, node.uid, node.gid, false);
		return;
	}
	rmSync(path, { recursive: true, force: true });
	if (node.kind === "missing") return;
	mkdirSync(dirname(path), { recursive: true });
	if (node.kind === "symlink") {
		symlinkSync(node.target, path);
		restoreRuntimeLiveOwnership(path, node.uid, node.gid, true);
		return;
	}
	if (node.kind === "file") {
		writeFileSync(path, node.content, { mode: node.mode });
		chmodSync(path, node.mode);
		restoreRuntimeLiveOwnership(path, node.uid, node.gid, false);
		return;
	}
	mkdirSync(path, { recursive: true, mode: node.mode });
	chmodSync(path, node.mode);
	for (const [entry, child] of node.entries) restoreRuntimeLiveNode(join(path, entry), child);
	restoreRuntimeLiveOwnership(path, node.uid, node.gid, false);
}
