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
import { basename, dirname, join } from "node:path";
import type { RuntimeManifest } from "./manifest-contract";
import type { RuntimePaths } from "./paths";
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

export function runtimeLiveSnapshotPaths(manifest: RuntimeManifest, paths: RuntimePaths): string[] {
	const result = new Set<string>([
		paths.managedConfig,
		paths.syncState,
		paths.providerHealthStatus,
		paths.egressEngineStatus,
		paths.manifestLastGood,
		paths.managedSecretCacheFile,
		paths.appliedState,
		paths.egressProfileRoot,
		paths.installInventory,
		paths.projectionRoot,
		join(paths.instanceRoot, manifest.instanceId),
		paths.managedSecretFile,
		paths.daemonAuthToken,
		join(paths.managedSecretRoot, "egress-secrets.json"),
		paths.instanceData,
		paths.sensitiveInstanceData,
		paths.egressAddon,
		paths.egressTransparentEnv,
		paths.egressSystemCaFile,
		join(paths.serviceStateRoot, "config", "runtime-live-sync-agents.json"),
	]);
	for (const name of ["clawdi-runtime-watch", "clawdi-daemon", "clawdi-runtime-sidecar"]) {
		const unitName = `${name}.service`;
		result.add(join(paths.systemdSystemRoot, unitName));
		result.add(join(paths.systemdEnvRoot, `${unitName}.env`));
	}
	addExistingManagedSystemdSystemPaths(paths, result);
	return [...result].sort();
}

export function captureRuntimeLiveSnapshot(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
): RuntimeLiveSnapshot {
	for (const path of runtimeManagedDirectoryPaths(manifest, paths)) {
		assertRuntimeManagedDirectoryTrusted(path);
	}
	const snapshotPaths = runtimeLiveSnapshotPaths(manifest, paths);
	return {
		entries: new Map([
			...snapshotPaths.map((path) => [path, captureRuntimeLiveNode(path)] as const),
			...runtimeLiveSnapshotMetadataPaths(snapshotPaths).map(
				(path) => [path, captureRuntimeLiveMetadata(path)] as const,
			),
		]),
	};
}

export function restoreRuntimeLiveSnapshot(snapshot: RuntimeLiveSnapshot): void {
	for (const [path, node] of snapshot.entries) {
		if (node.kind !== "metadata") restoreRuntimeLiveNode(path, node);
	}
	for (const [path, node] of snapshot.entries) {
		if (node.kind === "metadata") restoreRuntimeLiveNode(path, node);
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

function runtimeManagedDirectoryPaths(manifest: RuntimeManifest, paths: RuntimePaths): string[] {
	return [
		paths.runConfigRoot,
		paths.systemdEnvRoot,
		paths.egressProfileRoot,
		paths.installInventory,
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
	if ((stat.mode & 0o022) !== 0) {
		throw new Error(`runtime managed directory is group/world writable: ${path}`);
	}
	if (runningAsRoot() && stat.uid !== 0) {
		throw new Error(`runtime managed directory is not root-owned: ${path}`);
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

function captureRuntimeLiveNode(path: string): RuntimeLiveSnapshotNode {
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
	if ((mode & 0o022) !== 0) {
		throw new Error(`runtime live-state snapshot directory is group/world writable: ${path}`);
	}
	if (runningAsRoot() && stat.uid !== 0) {
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
				.map((entry) => [entry, captureRuntimeLiveNode(join(path, entry))]),
		),
	};
}

function captureRuntimeLiveMetadata(path: string): RuntimeLiveSnapshotNode {
	try {
		const stat = lstatSync(path);
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

function runningAsRoot(): boolean {
	return typeof process.getuid === "function" && process.getuid() === 0;
}
