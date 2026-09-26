/**
 * Upstream Hermes adapter contract.
 *
 * Hosted Agents install Hermes with the official, unpinned installer, so every
 * surface the CLI adapter depends on is exercised here against whatever that
 * installer currently ships. Every check drives the CLI's own production code
 * or embedded helper sources; nothing here re-implements an adapter path.
 *
 * Run through `scripts/test-hermes-upstream-contract.sh`, which installs the
 * latest upstream Hermes as a non-root runtime user in a disposable container.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
	HERMES_CODEX_AUTH_HELPER,
	nativeOAuthProfileId,
} from "../../src/lib/codex-oauth-native-store";
import { HERMES_POOL_GUARD } from "../../src/runtime/connection-provider-config";
import {
	beginHermesConfigTransaction,
	commitHermesConfigTransaction,
	getHermesResolvedConfigValue,
	type HermesConfigCommandContext,
	reconcileHermesConfigValue,
} from "../../src/runtime/hermes-config";
import { reconcileHermesNativeCredentials } from "../../src/runtime/hermes-native-credentials";
import { hermesManagedPython } from "../../src/runtime/hermes-python";
import {
	type HostedAgentPluginRuntime,
	hostedAgentPluginTreeDigest,
	type PreparedHostedAgentPlugin,
	type PreparedHostedAgentPlugins,
} from "../../src/runtime/hosted-agent-plugin-package";
import {
	hostedAgentPluginCommands,
	prepareHostedAgentPluginTransaction,
} from "../../src/runtime/hosted-agent-plugin-runtime";
import {
	activateHostedHermesSkill,
	HERMES_SKILL_OPERATION,
	hostedHermesSkillSourceMatches,
	removeHostedHermesSkill,
} from "../../src/runtime/hosted-hermes-skill";
import { hostedSkillArchiveSourceIdentity } from "../../src/runtime/hosted-sourced-skill-archive";
import { reconcileManagedBaileysCompatibility } from "../../src/runtime/managed-baileys-compat";
import {
	HOSTED_GATEWAY_RUN_ARGS,
	HOSTED_HERMES_DASHBOARD_ARGS,
	type RuntimeManifest,
} from "../../src/runtime/manifest-contract";
import {
	HERMES_DASHBOARD_CAPABILITY_PROBE,
	runtimeAppRoot,
	runtimeCommandPath,
	runtimeCommandVersion,
} from "../../src/runtime/manifest-install";
import {
	AGENT_PLUGINS_SCHEMA_1_0_0,
	type HostedSkillSource,
} from "../../src/runtime/manifest-resources";
import { applyHostedRuntimeConfigProjection } from "../../src/runtime/manifest-runtime-config";
import { runtimeComponentIsReady, runtimeServiceIsReady } from "../../src/runtime/observed";
import { getRuntimePaths, type RuntimePaths } from "../../src/runtime/paths";
import {
	OFFICIAL_RUNTIME_SERVICE_DESCRIPTORS,
	prepareOfficialRuntimeServiceDependencies,
	type RuntimeSystemdUserProgram,
} from "../../src/runtime/runtime-systemd-reconciliation";
import { executableExists, spawnRuntimeUserCommand } from "../../src/runtime/runtime-user-command";

const CONTRACT_GATE = "CLAWDI_TEST_HERMES_UPSTREAM_CONTRACT";
const HERMES_DASHBOARD_PORT = 9119;
const SERVICE_READY_TIMEOUT_MS = 120_000;

const enabled = process.env[CONTRACT_GATE] === "1";
const home = process.env.HOME ?? "";
const hermesCommand = runtimeCommandPath("hermes", home) ?? "";
const appRoot = runtimeAppRoot("hermes", home) ?? "";
const hermesHome = join(home, ".hermes");
const originalEnv = { ...process.env };
const services: ChildProcess[] = [];
let scratch = "";
let paths: RuntimePaths;
let python: string | undefined;

/** The adapter's interpreter resolution, shared by every helper check. */
function managedPythonPath(): string {
	python ??= hermesManagedPython(home);
	return python;
}

function hermes(args: readonly string[], timeoutMs = 60_000) {
	const result = spawnRuntimeUserCommand(hermesCommand, [...args], home, home, {
		environmentOverrides: { HERMES_HOME: hermesHome },
		timeoutMs,
	});
	return {
		status: result.status,
		stdout: String(result.stdout ?? ""),
		stderr: String(result.stderr ?? ""),
	};
}

function managedPython(
	args: string[],
	input: string,
	cwd = home,
	environmentOverrides: Record<string, string> = {},
) {
	const result = spawnRuntimeUserCommand(managedPythonPath(), args, home, cwd, {
		input,
		environmentOverrides: { HERMES_HOME: hermesHome, ...environmentOverrides },
		timeoutMs: 120_000,
		maxBufferBytes: 1024 * 1024,
	});
	return {
		status: result.status,
		stdout: String(result.stdout ?? ""),
		stderr: String(result.stderr ?? ""),
	};
}

/** Hermes' own public read path for a credential pool, as its runtime consumes it. */
function hermesPoolIds(provider: string): string[] {
	const result = managedPython(
		[
			"-c",
			[
				"import json, sys",
				"sys.path.insert(0, sys.argv[1])",
				"from hermes_cli.auth import read_credential_pool",
				"rows = read_credential_pool(sys.argv[2])",
				"print(json.dumps([row.get('id') for row in rows]))",
			].join("\n"),
			appRoot,
			provider,
		],
		"",
	);
	expect(result.status, result.stderr).toBe(0);
	return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "null") as string[];
}

function lastJsonLine(output: string): Record<string, unknown> {
	return JSON.parse(output.trim().split("\n").at(-1) ?? "null") as Record<string, unknown>;
}

function expectNoCompatWarnings(stderr: string): void {
	expect(stderr).not.toContain("HermesPluginCompatWarning");
	expect(stderr).not.toContain("hermes plugin compat");
}

/** `hermes <subcommand...> --help` must accept every flag the CLI passes. */
function expectCommandSurface(argv: readonly string[]): void {
	const firstFlag = argv.findIndex((arg) => arg.startsWith("-"));
	const subcommand = firstFlag === -1 ? [...argv] : argv.slice(0, firstFlag);
	const flags = argv.filter((arg) => arg.startsWith("--"));
	const help = hermes([...subcommand, "--help"]);
	expect(help.status, `hermes ${subcommand.join(" ")} --help\n${help.stderr}`).toBe(0);
	for (const flag of flags) {
		expect(help.stdout, `hermes ${subcommand.join(" ")} must accept ${flag}`).toContain(flag);
	}
}

function startService(name: string, args: readonly string[]): ChildProcess {
	const log = join(scratch, `${name}.log`);
	const child = spawn(hermesCommand, [...args], {
		cwd: home,
		env: { ...process.env, HERMES_HOME: hermesHome },
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout?.on("data", (chunk) => writeFileSync(log, chunk, { flag: "a" }));
	child.stderr?.on("data", (chunk) => writeFileSync(log, chunk, { flag: "a" }));
	services.push(child);
	return child;
}

function serviceLog(name: string): string {
	const log = join(scratch, `${name}.log`);
	return existsSync(log) ? readFileSync(log, "utf8").slice(-4000) : "";
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return true;
		await Bun.sleep(1_000);
	}
	return check();
}

function agentPlugin(name: string, version: string): PreparedHostedAgentPlugin {
	const tree = [
		{
			path: "plugin.json",
			mode: 0o100644 as const,
			bytes: Buffer.from(JSON.stringify({ $schema: AGENT_PLUGINS_SCHEMA_1_0_0, name, version })),
		},
		{
			path: "skills/contract-probe/SKILL.md",
			mode: 0o100644 as const,
			bytes: Buffer.from(
				"---\nname: contract-probe\ndescription: Upstream contract probe.\n---\n\n# Probe\n",
			),
		},
	].sort((left, right) => left.path.localeCompare(right.path));
	const ownershipIdentity = createHash("sha256").update(`${name}@${version}`).digest("hex");
	return {
		name,
		installation: {
			installationId: `install_${ownershipIdentity.slice(0, 8)}`,
			version,
			agentPluginsSchema: AGENT_PLUGINS_SCHEMA_1_0_0,
			source: {
				type: "github",
				url: "https://github.com/clawdi-ai/agent-plugins",
				path: `plugins/${name}`,
				commit: ownershipIdentity.slice(0, 40),
			},
			contentDigest: hostedAgentPluginTreeDigest(tree),
			ownershipIdentity,
		},
		mcpServerNames: [],
		tree,
	};
}

function pluginState(
	runtime: HostedAgentPluginRuntime,
	desired: PreparedHostedAgentPlugin | null,
	previous: { plugin: PreparedHostedAgentPlugin; nativeId: string } | null,
): PreparedHostedAgentPlugins {
	return {
		runtime,
		desired: new Map(desired ? [[desired.name, desired]] : []),
		previous: new Map(
			previous
				? [
						[
							previous.plugin.name,
							{
								runtime,
								name: previous.plugin.name,
								installation: previous.plugin.installation,
								nativeId: previous.nativeId,
							},
						],
					]
				: [],
		),
		transientCacheOwnerships: new Set(),
	};
}

describe.skipIf(!enabled)("upstream Hermes adapter contract", () => {
	beforeAll(() => {
		if (!home || !existsSync(hermesCommand)) {
			throw new Error(`upstream Hermes is not installed for ${home || "the current user"}`);
		}
		scratch = mkdtempSync(join(tmpdir(), "clawdi-hermes-upstream-contract-"));
		// Hosted CLI shaping: named runtime user, hosted paths, private platform state.
		process.env.CLAWDI_RUNTIME_USER = userInfo().username;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_RUNTIME_HOME = home;
		process.env.CLAWDI_SERVICE_STATE_DIR = join(scratch, "state");
		process.env.CLAWDI_RUN_DIR = join(scratch, "run");
		process.env.CLAWDI_HOME = join(scratch, "clawdi-home");
		paths = getRuntimePaths({ mode: "hosted" });
	});

	afterAll(() => {
		for (const child of services) child.kill("SIGTERM");
		process.env = { ...originalEnv };
		if (scratch) rmSync(scratch, { recursive: true, force: true });
	});

	test("reports its version to the runtime revision probe", () => {
		expect(runtimeCommandVersion(hermesCommand, home, home)).toContain("Hermes Agent");
	});

	test("resolves the managed Python interpreter", () => {
		const resolved = managedPythonPath();
		expect(isAbsolute(resolved)).toBe(true);
		expect(executableExists(resolved)).toBe(true);
		console.log(`managed Python: ${resolved}`);
	});

	test("dashboard runtime passes the capability probe", () => {
		const result = managedPython(["-c", HERMES_DASHBOARD_CAPABILITY_PROBE], "");
		expect(result.status, result.stderr).toBe(0);
	});

	test("accepts every hosted service command line", () => {
		const hermesService = OFFICIAL_RUNTIME_SERVICE_DESCRIPTORS.find(
			(descriptor) => descriptor.runtime === "hermes",
		);
		if (!hermesService) throw new Error("Hermes official service descriptor is missing");
		for (const argv of [
			HOSTED_GATEWAY_RUN_ARGS,
			HOSTED_HERMES_DASHBOARD_ARGS,
			hermesService.installArgs,
			hermesService.uninstallArgs,
		]) {
			expectCommandSurface(argv);
		}
	});

	test("config path, get, and missing-key semantics match the config adapter", () => {
		const context: HermesConfigCommandContext = {
			command: hermesCommand,
			home,
			cwd: home,
			environment: { HERMES_HOME: hermesHome },
		};
		const transaction = beginHermesConfigTransaction(context);
		// Other adapter paths read this file directly.
		expect(transaction.path).toBe(join(hermesHome, "config.yaml"));
		reconcileHermesConfigValue(transaction, "model.provider", "openrouter");
		expect(commitHermesConfigTransaction(transaction)).toBe("committed");
		expect(getHermesResolvedConfigValue(context, "model.provider")).toEqual({
			exists: true,
			value: "openrouter",
		});
		expect(getHermesResolvedConfigValue(context, "clawdi_contract.missing")).toEqual({
			exists: false,
		});
		reconcileHermesConfigValue(context, "model.provider", undefined);
	});

	test("Skill helper installs and removes without compatibility shims", () => {
		const name = "clawdi-contract-helper";
		const target = join(hermesHome, "skills", name);
		const owned = {
			source: "clawdi",
			identifier: `project/contract/${name}@${"c".repeat(64)}`,
			scanSource: `project/contract/${name}@${"c".repeat(64)}`,
			identity: `project\0${name}\0contract\0${"c".repeat(64)}`,
		};
		const skill = Buffer.from(
			`---\nname: ${name}\ndescription: Upstream contract probe.\n---\n\n# Probe\n\nSay hello.\n`,
		).toString("base64");
		const run = (request: Record<string, unknown>) =>
			managedPython(["-B", "-c", HERMES_SKILL_OPERATION], JSON.stringify(request), appRoot, {
				PYTHONNOUSERSITE: "1",
			});

		const install = run({
			...owned,
			ownedSources: [owned],
			files: { "SKILL.md": skill },
			operation: "install",
			name,
			target,
		});
		expect(install.status, install.stderr).toBe(0);
		expect(lastJsonLine(install.stdout)).toEqual({ ok: true, targetMutationStarted: true });
		expectNoCompatWarnings(install.stderr);
		expect(existsSync(join(target, "SKILL.md"))).toBe(true);

		const remove = run({ ownedSources: [owned], operation: "remove", name, target });
		expect(remove.status, remove.stderr).toBe(0);
		expect(lastJsonLine(remove.stdout)).toEqual({
			ok: true,
			matches: true,
			targetMutationStarted: true,
		});
		expectNoCompatWarnings(remove.stderr);
		expect(existsSync(target)).toBe(false);
	});

	test("hosted Skill activation records native provenance and removes cleanly", () => {
		const skillId = "clawdi-contract-skill";
		const source: HostedSkillSource = {
			type: "project",
			projectId: "contract",
			contentHash: "d".repeat(64),
			archiveUrl: "https://cloud.example.test/archive",
			installUrl: "https://cloud.example.test/install",
		};
		const sourceDir = join(scratch, "skill-source", skillId);
		mkdirSync(sourceDir, { recursive: true });
		writeFileSync(
			join(sourceDir, "SKILL.md"),
			`---\nname: ${skillId}\ndescription: Upstream contract probe.\n---\n\n# Probe\n`,
		);
		const targetDir = join(hermesHome, "skills", skillId);

		activateHostedHermesSkill({ home, sourceDir, targetDir, source });
		expect(hostedHermesSkillSourceMatches(home, targetDir, source)).toBe(true);
		removeHostedHermesSkill(home, targetDir, [hostedSkillArchiveSourceIdentity(skillId, source)]);
		expect(existsSync(targetDir)).toBe(false);
	});

	test("custom provider pool guard uses the public pool API", () => {
		const result = managedPython(
			["-c", HERMES_POOL_GUARD, appRoot],
			JSON.stringify([{ id: "clawdi-contract", baseUrl: "https://example.test/v1" }]),
		);
		expect(result.status, result.stderr).toBe(0);
		// A fresh install has no native pool rows, so no connection conflicts.
		expect(JSON.parse(result.stdout)).toEqual({ conflicts: [] });
	});

	test("native provider credentials round-trip through the Hermes pool", () => {
		const input = {
			home,
			workspaceRoot: home,
			strategies: {},
		};
		const added = reconcileHermesNativeCredentials({
			...input,
			providers: [
				{
					providerId: "openrouter",
					apiKey: "sk-clawdi-contract-not-real",
					baseUrl: "https://openrouter.ai/api/v1",
				},
			],
			previousProviderIds: [],
		});
		expect(added.changed).toBe(true);
		expect(hermesPoolIds("openrouter")).toEqual(["clawdi-native-api-key"]);

		const removed = reconcileHermesNativeCredentials({
			...input,
			providers: [],
			previousProviderIds: ["openrouter"],
		});
		expect(removed.changed).toBe(true);
		expect(hermesPoolIds("openrouter")).toEqual([]);
	});

	test("Codex OAuth credential written by the CLI is read by Hermes", () => {
		const authPath = join(hermesHome, "auth.json");
		const profileId = nativeOAuthProfileId("hermes", "clawdi-contract-codex");
		const runHelper = (args: string[], material: unknown) => {
			// Same invocation as the runtime OAuth reconciler.
			const result = spawnRuntimeUserCommand(
				"flock",
				[
					"--timeout",
					"10",
					join(dirname(authPath), "auth.lock"),
					"node",
					"--input-type=module",
					"--eval",
					HERMES_CODEX_AUTH_HELPER,
					authPath,
					...args,
				],
				home,
				home,
				{ input: JSON.stringify(material) },
			);
			expect(result.status, String(result.stderr)).toBe(0);
			return JSON.parse(String(result.stdout)) as Record<string, unknown>;
		};

		const upsert = runHelper(["upsert", profileId, "", "revision-1", "missing"], {
			accessToken: "access-contract-not-real",
			refreshToken: "refresh-contract-not-real",
			lastRefresh: new Date().toISOString(),
		});
		expect(upsert).toMatchObject({ updated: true, casMatched: true });
		expect(hermesPoolIds("openai-codex")).toContain(profileId);

		const remove = runHelper(
			[
				"remove",
				profileId,
				profileId,
				"revision-1",
				String(upsert.afterCredentialFingerprint ?? ""),
			],
			null,
		);
		expect(remove).toMatchObject({ updated: true, casMatched: true });
		expect(hermesPoolIds("openai-codex")).not.toContain(profileId);
	});

	test("Agent Plugin lifecycle converges through the native plugin CLI", () => {
		const commands = hostedAgentPluginCommands(home);
		const desired = agentPlugin("clawdi-contract-plugin", "1.0.0");

		const receipt = prepareHostedAgentPluginTransaction({
			prepared: pluginState("hermes", desired, null),
			home,
			commands,
		}).apply();
		const nativeId = receipt?.installations[desired.name]?.nativeId;
		if (!nativeId) throw new Error("Hermes did not report the installed Agent Plugin");

		const removal = prepareHostedAgentPluginTransaction({
			prepared: pluginState("hermes", null, { plugin: desired, nativeId }),
			home,
			commands,
		});
		expect(removal.mutationNames).toEqual([desired.name]);
		expect(removal.apply()).toBeNull();
		const listed = hermes(["plugins", "list", "--json"]);
		expect(listed.status, listed.stderr).toBe(0);
		expect(
			(JSON.parse(listed.stdout) as Array<{ name: string }>).map((plugin) => plugin.name),
		).not.toContain(nativeId);
	}, 300_000);

	test("dashboard cold build produces the served web UI", () => {
		// Remove any installer-built bundle so only the adapter's build can satisfy the check.
		rmSync(join(appRoot, "hermes_cli", "web_dist"), { recursive: true, force: true });
		const gateway: RuntimeSystemdUserProgram = {
			programKind: "runtime",
			runtime: "hermes",
			service: null,
			command: hermesCommand,
			args: [...HOSTED_GATEWAY_RUN_ARGS],
			cwd: home,
			env: {},
			resolvedSecretEnv: {},
		};
		const dashboard: RuntimeSystemdUserProgram = {
			...gateway,
			service: "dashboard",
			args: [...HOSTED_HERMES_DASHBOARD_ARGS],
		};
		const failure = prepareOfficialRuntimeServiceDependencies(
			[gateway, dashboard],
			{
				pending: [{ unitName: "hermes-gateway.service", program: gateway, serviceRevision: null }],
				serviceRevisions: {},
			},
			paths,
		);
		if (failure) {
			const log = join(paths.statusRoot, "installer-logs", "hermes-dashboard-prerequisite.log");
			throw new Error(
				`${failure}\n${existsSync(log) ? readFileSync(log, "utf8").slice(-4000) : ""}`,
			);
		}
		expect(existsSync(join(appRoot, "hermes_cli", "web_dist", "index.html"))).toBe(true);
	}, 900_000);

	test("hosted gateway and OIDC dashboard become ready", async () => {
		const manifest: RuntimeManifest = {
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "hdep_contract",
			environmentId: "environment-contract",
			instanceId: "instance-contract",
			generation: 1,
			issuedAt: new Date().toISOString(),
			workspaceRoot: home,
			controlPlane: { apiUrl: "https://cloud-api.example.test" },
			runtimes: { hermes: { enabled: true, services: {} } },
			recovery: {},
			hermesDashboardAuth: {
				mode: "oidc",
				provider: "self-hosted",
				deploymentId: "hdep_contract",
				issuer: "https://api.example.test/v2/hermes/oidc",
				clientId: "clawdi-hermes-hdep_contract-r1",
				accessRevision: 1,
				publicUrl: "https://hermes.example.test",
				trustedProxies: ["127.0.0.1"],
				activation: { enabled: true, capability: "hermes-self-hosted-oidc-v1" },
			},
		};
		const config = beginHermesConfigTransaction({
			command: hermesCommand,
			home,
			cwd: home,
			environment: { HERMES_HOME: hermesHome },
		});
		applyHostedRuntimeConfigProjection("hermes", manifest, home, null, home, config);
		expect(commitHermesConfigTransaction(config)).toBe("committed");

		expect(HOSTED_HERMES_DASHBOARD_ARGS).toContain(String(HERMES_DASHBOARD_PORT));
		startService("gateway", HOSTED_GATEWAY_RUN_ARGS);
		startService("dashboard", HOSTED_HERMES_DASHBOARD_ARGS);

		const ready = await waitFor(
			async () =>
				(await runtimeServiceIsReady("clawdi-hermes-dashboard.service", paths)) &&
				(await runtimeComponentIsReady("hermes-ui", paths)),
			SERVICE_READY_TIMEOUT_MS,
		);
		if (!ready) {
			throw new Error(
				`Hermes services did not become ready\n--- gateway\n${serviceLog("gateway")}\n--- dashboard\n${serviceLog("dashboard")}`,
			);
		}
	}, 300_000);

	test("managed WhatsApp compatibility patches the Hermes bridge Baileys", () => {
		expect(
			reconcileManagedBaileysCompatibility({ desiredRuntime: "hermes", home, appRoot }),
		).toEqual({ status: "applied" });
		expect(reconcileManagedBaileysCompatibility({ desiredRuntime: null, home })).toEqual({
			status: "rolled-back",
		});
	}, 600_000);
});
