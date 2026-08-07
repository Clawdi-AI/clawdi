import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CurrentCliInvocation } from "../lib/current-cli-invocation";
import {
	OperationManager,
	type OperationShutdownOptions,
	runCliCommandImmediate,
} from "./operation-runner";

const root = mkdtempSync(join(tmpdir(), "clawdi-operation-runner-"));
const worker = join(root, "worker.ts");
writeFileSync(
	worker,
	[
		'import { spawn } from "node:child_process";',
		'import { writeFileSync } from "node:fs";',
		'const mode = process.argv[2] ?? "";',
		'const marker = process.argv[3] ?? "";',
		'if (mode === "grandchild") {',
		'  process.on("SIGTERM", () => {});',
		"  setInterval(() => {}, 1_000);",
		'} else if (mode === "stubborn" || mode === "orphaning") {',
		'  process.on("SIGTERM", () => { if (mode === "orphaning") process.exit(0); });',
		'  const grandchild = spawn(process.execPath, [process.argv[1] ?? "", "grandchild", marker], { stdio: "ignore" });',
		"  writeFileSync(marker, String(grandchild.pid));",
		'  console.log("ready");',
		"  setInterval(() => {}, 1_000);",
		"} else {",
		'  process.on("SIGTERM", () => {',
		"    setTimeout(() => {",
		'      writeFileSync(marker, "closed");',
		"      process.exit(0);",
		"    }, 75);",
		"  });",
		'  console.log("ready");',
		"  setInterval(() => {}, 1_000);",
		"}",
	].join("\n"),
);

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

if (process.platform !== "win32") {
	describe("operation process-group cleanup", () => {
		it("waits for operation close after TERM and keeps cancellation status", async () => {
			const marker = join(root, "graceful-marker");
			const manager = createManager();
			const operation = manager.start({ name: "graceful", args: ["graceful", marker] });
			await waitForOperationReady(manager, operation.id);

			const started = Date.now();
			await manager.shutdownAll({ termTimeoutMs: 1_000 });

			expect(Date.now() - started).toBeGreaterThanOrEqual(50);
			expect(readFileSync(marker, "utf-8")).toBe("closed");
			expect(manager.get(operation.id)).toMatchObject({
				status: "cancelled",
				exit_code: 0,
				signal: null,
			});
			expect(() => manager.start({ name: "late", args: ["graceful", marker] })).toThrow(
				"daemon is shutting down",
			);
		});

		it("escalates to KILL for the entire operation process group", async () => {
			const pidFile = join(root, "grandchild-pid");
			const manager = createManager();
			const operation = manager.start({ name: "stubborn", args: ["stubborn", pidFile] });
			await waitForOperationReady(manager, operation.id);
			await waitFor(() => existsSync(pidFile));
			const grandchildPid = Number(readFileSync(pidFile, "utf-8"));

			await manager.shutdownAll({ termTimeoutMs: 50 });

			expect(manager.get(operation.id)).toMatchObject({
				status: "cancelled",
				signal: "SIGKILL",
			});
			await waitFor(() => !processExists(grandchildPid));
		});

		it("escalates cancellation so stubborn descendants do not survive", async () => {
			const pidFile = join(root, "cancel-grandchild-pid");
			const manager = createManager({ termTimeoutMs: 50, killTimeoutMs: 100 });
			const operation = manager.start({ name: "cancel", args: ["orphaning", pidFile] });
			await waitForOperationReady(manager, operation.id);
			await waitFor(() => existsSync(pidFile));
			const grandchildPid = Number(readFileSync(pidFile, "utf-8"));

			expect(manager.cancel(operation.id)?.status).toBe("cancelled");
			await waitFor(() => !processExists(grandchildPid));
			expect(manager.get(operation.id)?.status).toBe("cancelled");
		});

		it("keeps a cancelled exclusive operation active until its process closes", async () => {
			const manager = createManager();
			const operation = manager.start({
				name: "first",
				args: ["graceful", join(root, "exclusive-first-marker")],
				exclusiveKey: "sync",
			});
			await waitForOperationReady(manager, operation.id);

			expect(manager.cancel(operation.id)?.status).toBe("cancelled");
			expect(() =>
				manager.start({
					name: "overlap",
					args: ["graceful", join(root, "exclusive-overlap-marker")],
					exclusiveKey: "sync",
				}),
			).toThrow("Another sync operation is already running");
			await waitFor(() => manager.get(operation.id)?.exit_code === 0);

			const replacement = manager.start({
				name: "replacement",
				args: ["graceful", join(root, "exclusive-replacement-marker")],
				exclusiveKey: "sync",
			});
			await waitForOperationReady(manager, replacement.id);
			await manager.shutdownAll();
		});

		it("cleans the process group before resolving an immediate timeout", async () => {
			const pidFile = join(root, "immediate-grandchild-pid");

			const result = await runCliCommandImmediate(
				{ name: "immediate", args: ["orphaning", pidFile], timeoutMs: 100 },
				workerInvocation,
			);

			expect(result).toMatchObject({ exit_code: null, signal: "SIGTERM" });
			expect(result.stderr).toContain("Command timed out after 100ms");
			const grandchildPid = Number(readFileSync(pidFile, "utf-8"));
			await waitFor(() => !processExists(grandchildPid));
		});
	});
}

function createManager(options: OperationShutdownOptions = {}): OperationManager {
	return new OperationManager(workerInvocation, options);
}

function workerInvocation(args: readonly string[]): CurrentCliInvocation {
	return {
		command: process.execPath,
		args: [worker, ...args],
		entryPath: worker,
	};
}

async function waitForOperationReady(manager: OperationManager, id: string): Promise<void> {
	await waitFor(() => manager.logs(id)?.stdout.includes("ready") === true);
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("timed out waiting for operation test condition");
}

function processExists(pid: number): boolean {
	// A container runtime without an init process may leave the killed orphan as
	// a zombie briefly. It is already terminated even though kill(pid, 0) still
	// finds its process-table entry.
	if (process.platform === "linux") {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
			const stateOffset = stat.lastIndexOf(") ") + 2;
			if (stateOffset > 1 && stat[stateOffset] === "Z") return false;
		} catch {
			// Fall through to the portable existence probe.
		}
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
