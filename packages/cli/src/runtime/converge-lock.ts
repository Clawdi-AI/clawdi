import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { RuntimePaths } from "./paths";

function ownerPath(lockDir: string): string {
	return join(lockDir, "owner.json");
}

function writeFileAtomic(path: string, content: string, mode: number): void {
	const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
	let renamed = false;
	try {
		writeFileSync(tmp, content, { mode });
		renameSync(tmp, path);
		renamed = true;
	} finally {
		if (!renamed) rmSync(tmp, { force: true });
	}
}

function writeOwner(lockDir: string): void {
	writeFileAtomic(
		ownerPath(lockDir),
		`${JSON.stringify({
			schemaVersion: "clawdi.runtimeConvergeLockOwner.v1",
			pid: process.pid,
			acquiredAt: new Date().toISOString(),
		})}\n`,
		0o600,
	);
}

function readOwnerPid(lockDir: string): number | null {
	try {
		const raw = JSON.parse(readFileSync(ownerPath(lockDir), "utf-8")) as unknown;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
		const pid = (raw as Record<string, unknown>).pid;
		return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
		return true;
	}
}

function reclaimStale(lockDir: string, timeoutMs: number): boolean {
	const ownerPid = readOwnerPid(lockDir);
	if (ownerPid === null) {
		let mtimeMs: number;
		try {
			mtimeMs = statSync(lockDir).mtimeMs;
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
			throw error;
		}
		if (Date.now() - mtimeMs <= 2 * timeoutMs) return false;
	} else if (processIsAlive(ownerPid)) {
		return false;
	}
	const staleDir = `${lockDir}.stale.${process.pid}.${Date.now()}.${Math.random()
		.toString(36)
		.slice(2)}`;
	try {
		renameSync(lockDir, staleDir);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
		throw error;
	}
	rmSync(staleDir, { recursive: true, force: true });
	return true;
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockPath(paths: RuntimePaths): string {
	const lockRoot = join(paths.runRoot, "locks");
	mkdirSync(lockRoot, { recursive: true });
	return join(lockRoot, "converge.lock");
}

function tryAcquire(lockDir: string, timeoutMs: number, startedAt: number): boolean {
	try {
		mkdirSync(lockDir);
		try {
			writeOwner(lockDir);
		} catch (error) {
			rmSync(lockDir, { recursive: true, force: true });
			throw error;
		}
		return true;
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
		if (reclaimStale(lockDir, timeoutMs)) return false;
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error(`timed out waiting for runtime converge lock at ${lockDir}`);
		}
		return false;
	}
}

export function withRuntimeConvergeLock<T>(
	paths: RuntimePaths,
	fn: () => T,
	opts: { timeoutMs?: number } = {},
): T {
	const timeoutMs = opts.timeoutMs ?? 300_000;
	const lockDir = lockPath(paths);
	const startedAt = Date.now();
	while (!tryAcquire(lockDir, timeoutMs, startedAt)) sleepSync(100);
	try {
		return fn();
	} finally {
		rmSync(lockDir, { recursive: true, force: true });
	}
}

export async function withRuntimeConvergeLockAsync<T>(
	paths: RuntimePaths,
	fn: () => Promise<T>,
	opts: { timeoutMs?: number } = {},
): Promise<T> {
	const timeoutMs = opts.timeoutMs ?? 300_000;
	const lockDir = lockPath(paths);
	const startedAt = Date.now();
	while (!tryAcquire(lockDir, timeoutMs, startedAt)) {
		await new Promise<void>((resolve) => setTimeout(resolve, 100));
	}
	try {
		return await fn();
	} finally {
		rmSync(lockDir, { recursive: true, force: true });
	}
}
