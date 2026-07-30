import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readRuntimeCredential } from "./auth-token";
import { getRuntimePaths } from "./paths";
import { processRuntimeEnvironment, projectedRuntimeEnvironment } from "./secret-values";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runtimePaths() {
	const root = mkdtempSync(join(tmpdir(), "clawdi-runtime-credential-"));
	roots.push(root);
	const previousRunDir = process.env.CLAWDI_RUN_DIR;
	process.env.CLAWDI_RUN_DIR = join(root, "run");
	try {
		return getRuntimePaths({ mode: "hosted" });
	} finally {
		if (previousRunDir === undefined) delete process.env.CLAWDI_RUN_DIR;
		else process.env.CLAWDI_RUN_DIR = previousRunDir;
	}
}

function seedLegacyToken(path: string): { bytes: string; mtimeMs: number } {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "legacy-file-token\n");
	const fixedTime = new Date("2026-07-30T00:00:00.000Z");
	utimesSync(path, fixedTime, fixedTime);
	return { bytes: readFileSync(path, "utf-8"), mtimeMs: statSync(path).mtimeMs };
}

describe("runtime credential reads", () => {
	test("uses only the projected credential and never falls back to the legacy file", () => {
		const paths = runtimePaths();
		const before = seedLegacyToken(paths.daemonAuthToken);
		expect(
			readRuntimeCredential(
				paths,
				projectedRuntimeEnvironment({
					CLAWDI_RUNTIME_AUTH_ENV: "PROJECTED_RUNTIME_TOKEN",
					PROJECTED_RUNTIME_TOKEN: "projected-runtime-token",
				}),
			),
		).toBe("projected-runtime-token");
		expect(
			readRuntimeCredential(
				paths,
				projectedRuntimeEnvironment({
					CLAWDI_RUNTIME_AUTH_ENV: "PROJECTED_RUNTIME_TOKEN",
				}),
			),
		).toBeNull();
		expect(readFileSync(paths.daemonAuthToken, "utf-8")).toBe(before.bytes);
		expect(statSync(paths.daemonAuthToken).mtimeMs).toBe(before.mtimeMs);
	});

	test("keeps legacy process-environment precedence and file fallback", () => {
		const paths = runtimePaths();
		const before = seedLegacyToken(paths.daemonAuthToken);
		expect(
			readRuntimeCredential(
				paths,
				processRuntimeEnvironment({
					CLAWDI_RUNTIME_AUTH_ENV: "PROCESS_RUNTIME_TOKEN",
					PROCESS_RUNTIME_TOKEN: "process-runtime-token",
				}),
			),
		).toBe("process-runtime-token");
		expect(
			readRuntimeCredential(
				paths,
				processRuntimeEnvironment({
					CLAWDI_RUNTIME_AUTH_ENV: "PROCESS_RUNTIME_TOKEN",
				}),
			),
		).toBe("legacy-file-token");
		expect(readFileSync(paths.daemonAuthToken, "utf-8")).toBe(before.bytes);
		expect(statSync(paths.daemonAuthToken).mtimeMs).toBe(before.mtimeMs);
	});
});
