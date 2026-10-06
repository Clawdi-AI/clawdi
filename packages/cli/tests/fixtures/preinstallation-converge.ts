// Execute production v2 configuration and service activation in a disposable
// native guest. The manifest and credentials belong only to this fixture.
import childProcess from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";
import { applyRuntimeManifestLoad } from "../../src/commands/runtime";
import { officialInstallArgs, type RuntimeManifest } from "../../src/runtime/manifest-contract";
import type { RuntimeManifestLoad } from "../../src/runtime/manifest-source";
import { getRuntimePaths } from "../../src/runtime/paths";
import { ensureRuntimeStateDirs } from "../../src/runtime/state";

const runtime = process.argv[2];
if (runtime !== "openclaw" && runtime !== "hermes") throw new Error("unsupported runtime");
Object.assign(process.env, {
	CLAWDI_RUNTIME_MODE: "hosted",
	CLAWDI_RUNTIME_USER: "clawdi",
	CLAWDI_RUNTIME_UID: "10001",
	CLAWDI_RUNTIME_GID: "10001",
	CLAWDI_RUNTIME_HOME: "/home/clawdi",
	CLAWDI_CODEX_INSTALL_DISABLED: "1",
});
// Services must invoke the real paired CLI, not this fixture entrypoint.
process.argv[1] = "/opt/native-cli/node_modules/clawdi/dist/index.js";
const paths = getRuntimePaths({ mode: "hosted" });
ensureRuntimeStateDirs(paths);
const manifest: RuntimeManifest = {
	schemaVersion: "clawdi.runtimeDesiredState.v1",
	deploymentId: "hdep_prewarm_fixture",
	environmentId: "env_prewarm_fixture",
	instanceId: "hri_prewarm_fixture",
	generation: 1,
	issuedAt: "2026-10-04T00:00:00Z",
	runtime,
	workspaceRoot: "/home/clawdi/workspace",
	controlPlane: { apiUrl: "https://cloud.example.invalid" },
	recovery: {},
	...(runtime === "openclaw"
		? {
				openclawGatewayAuth: {
					mode: "token",
					tokenRef: "secret://runtime/openclaw/gateway-token",
					deviceAuthRequired: false,
					activation: { enabled: true, capability: "openclaw-native-auth-v1" },
				},
			}
		: {
				hermesDashboardAuth: {
					mode: "oidc",
					provider: "self-hosted",
					deploymentId: "hdep_prewarm_fixture",
					issuer: "https://api.example.invalid/v2/hermes/oidc",
					clientId: "clawdi-hermes-hdep_prewarm_fixture-r1",
					accessRevision: 1,
					publicUrl: "https://agent.example.invalid/hermes",
					trustedProxies: ["10.173.0.1"],
					activation: { enabled: true, capability: "hermes-self-hosted-oidc-v1" },
				},
			}),
	runtimes: {
		[runtime]: {
			enabled: true,
			providerMode: "unmanaged",
			install: {
				authority: "official",
				method: "official-installer",
				url:
					runtime === "openclaw"
						? "https://openclaw.ai/install-cli.sh"
						: "https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh",
				home: "/home/clawdi",
				args: officialInstallArgs(runtime, "/home/clawdi"),
			},
			run: {
				command: `/home/clawdi/.local/bin/${runtime}`,
				args: ["gateway", "run"],
				env: {},
				prependPath: [],
			},
			services:
				runtime === "hermes"
					? {
							dashboard: {
								args: [
									"dashboard",
									"--host",
									"0.0.0.0",
									"--port",
									"9119",
									"--no-open",
									"--skip-build",
								],
								env: {},
								prependPath: [],
							},
						}
					: {},
		},
	},
};
const load: RuntimeManifestLoad = {
	manifest,
	source: "remote-datasource",
	sourcePath: "prewarm-native-fixture",
	offline: false,
	secretValues: { "secret://runtime/openclaw/gateway-token": "disposable-fixture-token" },
	applyContext: {
		kind: "context-file",
		backend: "incus",
		identity: {
			generation: 1,
			manifestETag: '"prewarm-fixture"',
			applyReceiptId: "prewarm-fixture-receipt",
			bootNonce: "prewarm-fixture-boot",
		},
		manifestSource: {
			type: "http",
			url: "https://runtime.example.invalid/manifest",
			auth: { type: "bearer", token: "disposable-fixture-token" },
		},
	},
};
// Fixture-only subprocess profiling. Record command names/known verbs, never
// environment, command payloads, credentials, or subprocess output.
const subprocesses: { command: string; milliseconds: number }[] = [];
function commandLabel(args: unknown[]): string {
	let command = typeof args[0] === "string" ? basename(args[0]) : "unknown";
	let argv = Array.isArray(args[1])
		? args[1].filter((v): v is string => typeof v === "string")
		: [];
	if (command === "setpriv" || command === "runuser") {
		const separator = argv.indexOf("--");
		command = basename(argv[separator + 1] ?? command);
		argv = argv.slice(separator + 2);
	}
	if (command === "env") {
		const index = argv.findIndex((arg) => !arg.includes("=") && !arg.startsWith("-"));
		if (index >= 0) {
			command = basename(argv[index] ?? command);
			argv = argv.slice(index + 1);
		}
	}
	const verb = argv[0];
	const known = new Set([
		"--version",
		"--help",
		"-c",
		"gateway",
		"config",
		"dashboard",
		"show",
		"start",
		"restart",
		"daemon-reload",
		"is-active",
		"install",
		"ci",
		"run",
	]);
	return known.has(verb ?? "") ? `${command} ${verb}` : command;
}
function instrument<T extends (...args: never[]) => unknown>(command: T): T {
	return new Proxy(command, {
		apply(target, thisArg, args) {
			const started = performance.now();
			try {
				return Reflect.apply(target, thisArg, args);
			} finally {
				subprocesses.push({
					command: commandLabel(args),
					milliseconds: performance.now() - started,
				});
			}
		},
	});
}
childProcess.spawnSync = instrument(childProcess.spawnSync);
childProcess.execFileSync = instrument(childProcess.execFileSync);
syncBuiltinESMExports();
const started = performance.now();
const result = await applyRuntimeManifestLoad(load, paths);
writeFileSync(
	"/opt/prewarm-profile.json",
	JSON.stringify({ milliseconds: performance.now() - started, subprocesses }),
);
writeFileSync("/opt/prewarm-convergence.json", JSON.stringify(result));
if (result.kind !== "converged") throw new Error(`unexpected apply result: ${result.kind}`);
if (result.convergence.installErrors.length) {
	const errors = result.convergence.installErrors.join("\n");
	for (const match of errors.matchAll(
		/see (\/var\/lib\/clawdi\/status\/installer-logs\/[a-z0-9-]+\.log)/g,
	)) {
		const path = match[1];
		if (path && existsSync(path)) console.error(readFileSync(path, "utf8").slice(-8192));
	}
	throw new Error(errors);
}
console.log(JSON.stringify({ converged: true, runtime }));
