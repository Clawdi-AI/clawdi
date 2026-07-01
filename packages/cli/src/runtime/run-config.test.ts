import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRuntimePaths, type RuntimePaths } from "./paths";
import {
	buildRuntimeRunConfig,
	buildRuntimeRunInvocation,
	type RuntimeRunSettings,
	readRuntimeRunConfigForCommand,
	readRuntimeServiceRunConfig,
	runtimeRunConfigPath,
	writeRuntimeRunConfig,
} from "./run-config";

const originalEnv = { ...process.env };
const tempRoots: string[] = [];

function tempRuntimePaths(): RuntimePaths {
	const root = mkdtempSync(join(tmpdir(), "clawdi-run-config-test-"));
	tempRoots.push(root);
	process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
	process.env.CLAWDI_RUN_DIR = join(root, "run");
	process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
	return getRuntimePaths({ mode: "hosted" });
}

function runSettings(command: string, args: string[]): RuntimeRunSettings {
	return { command, args, env: {}, prependPath: [] };
}

afterEach(() => {
	process.env = { ...originalEnv };
	for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime run config services", () => {
	test("keeps runtime services out of ordinary runtime command lookup", () => {
		const paths = tempRuntimePaths();
		writeRuntimeRunConfig(
			buildRuntimeRunConfig({
				runtime: "hermes",
				enabled: true,
				generatedAt: "2026-07-01T00:00:00.000Z",
				generation: 1,
				instanceId: "hri_test",
				commandPath: null,
				appRoot: null,
				workspaceRoot: "/home/clawdi/clawdi",
				settings: runSettings("hermes", ["gateway", "run"]),
			}),
			paths,
		);
		writeRuntimeRunConfig(
			buildRuntimeRunConfig({
				runtime: "hermes",
				service: "dashboard",
				enabled: true,
				generatedAt: "2026-07-01T00:00:00.000Z",
				generation: 1,
				instanceId: "hri_test",
				commandPath: null,
				appRoot: null,
				workspaceRoot: "/home/clawdi/clawdi",
				settings: runSettings("hermes", [
					"dashboard",
					"--host",
					"127.0.0.1",
					"--port",
					"9119",
					"--no-open",
				]),
			}),
			paths,
		);

		expect(runtimeRunConfigPath("hermes", paths).endsWith("/hermes.json")).toBe(true);
		expect(
			runtimeRunConfigPath("hermes", paths, "dashboard").endsWith("/hermes+dashboard.json"),
		).toBe(true);

		const runtime = readRuntimeRunConfigForCommand("hermes", paths);
		expect(runtime.status).toBe("ok");
		if (runtime.status !== "ok") throw new Error("expected hermes run config");
		expect(runtime.config.service).toBeNull();
		expect(buildRuntimeRunInvocation(runtime, ["hermes"], {}, paths).args).toEqual([
			"gateway",
			"run",
		]);

		expect(readRuntimeRunConfigForCommand("hermes+dashboard", paths).status).toBe("not-runtime");
		const service = readRuntimeServiceRunConfig("hermes", "dashboard", paths);
		expect(service.status).toBe("ok");
		if (service.status !== "ok") throw new Error("expected hermes dashboard run config");
		expect(service.config.service).toBe("dashboard");
		expect(buildRuntimeRunInvocation(service, ["hermes"], {}, paths).args).toEqual([
			"dashboard",
			"--host",
			"127.0.0.1",
			"--port",
			"9119",
			"--no-open",
		]);
	});
});
