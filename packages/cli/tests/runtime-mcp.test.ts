import { describe, expect, it } from "bun:test";

import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";

import { dirname, join } from "node:path";

import { writeRuntimeAppliedState } from "../src/runtime/applied-state";

import {
	managedSkillReservationLedgerPath,
	releaseManagedSkill,
	reserveManagedSkill,
} from "../src/runtime/managed-skill-reservation";

import type { RuntimeManifest } from "../src/runtime/manifest";

import { officialInstallArgs } from "../src/runtime/manifest-contract";

import type { RuntimeManifestLoad } from "../src/runtime/manifest-source";

import { getRuntimePaths } from "../src/runtime/paths";

import { ensureRuntimeStateDirs } from "../src/runtime/state";

import {
	convergeAndCommitTestRuntimeManifest,
	convergeRuntimeManifest,
	expectRecord,
	hostedSingleProviderModeLoad,
	installRuntimeTestHooks,
	managedRemoteMcpServer,
	nativeManagedRemoteMcpServer,
	readHermesConfigYaml,
	readOpenClawMcpServers,
	readSystemdEnvFile,
	readSystemdSystemUnit,
	readSystemdUserServiceConfig,
	root,
	TEST_PROCESS_GID,
	TEST_PROCESS_UID,
	TEST_PROCESS_USER,
	writeFakeOpenClawMcpBinary,
	writeHermesVersionBinary,
} from "../src/test-support/runtime-harness";

installRuntimeTestHooks();

describe("runtime manifest datasource", () => {
	it("installs OpenClaw before applying hosted MCP projections and fails closed without it", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "workspace");
		const installer = join(root, "openclaw-installer.sh");
		const installerLog = join(root, "openclaw-installer.log");
		const { commandPath } = writeFakeOpenClawMcpBinary(home);
		const fixtureBinary = join(root, "openclaw-fixture");
		writeFileSync(fixtureBinary, readFileSync(commandPath));
		chmodSync(fixtureBinary, 0o700);
		rmSync(commandPath);
		writeFileSync(
			installer,
			`#!/usr/bin/env bash
set -euo pipefail
prefix=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--prefix" ]; then
    prefix="$2"
    shift 2
    continue
  fi
  shift
done
test "$prefix" = "$HOME/.local"
printf 'installed\n' > '${installerLog}'
install -D -m 700 '${fixtureBinary}' "$prefix/bin/openclaw"
`,
		);
		chmodSync(installer, 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
		process.env.CLAWDI_RUNTIME_TEST_OPENCLAW_INSTALLER = installer;

		const load = (
			generation: number,
			revision: string,
			install: RuntimeManifest["runtimes"][string]["install"],
		): RuntimeManifestLoad => {
			const loaded = hostedSingleProviderModeLoad(home, "openclaw", "unmanaged", generation);
			loaded.manifest.workspaceRoot = workspace;
			loaded.manifest.runtimes.openclaw.install = install;
			loaded.manifest.projection = {
				...loaded.manifest.projection,
				mcp: { servers: { clawdi: managedRemoteMcpServer("clawdi", revision) } },
			};
			loaded.secretValues = {
				...loaded.secretValues,
				"secret://mcp/clawdi": "deploy-key-secret",
			};
			return loaded;
		};
		const officialInstall = {
			authority: "official" as const,
			method: "official-installer" as const,
			url: "https://openclaw.ai/install-cli.sh",
			home,
			args: officialInstallArgs("openclaw", home),
		};

		const installed = convergeAndCommitTestRuntimeManifest(
			load(1, "v1", officialInstall),
			getRuntimePaths(),
		);

		expect(installed.installErrors).toEqual([]);
		expect(readFileSync(installerLog, "utf-8")).toBe("installed\n");
		expect(readOpenClawMcpServers(home).clawdi).toEqual({
			...nativeManagedRemoteMcpServer("clawdi", "v1"),
			requestTimeoutMs: 420_000,
		});

		rmSync(commandPath);
		const unavailable = convergeAndCommitTestRuntimeManifest(
			load(2, "v2", undefined),
			getRuntimePaths(),
		);

		expect(unavailable.installErrors.join("\n")).toContain(
			"could not mutate managed OpenClaw MCP servers: runtime is unavailable",
		);
		expect(readOpenClawMcpServers(home).clawdi).toEqual({
			...nativeManagedRemoteMcpServer("clawdi", "v1"),
			requestTimeoutMs: 420_000,
		});
	});

	it("reconciles generic MCP maps and cleans the previously managed runtime on switch", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "workspace");
		const hermesBin = join(home, ".local", "bin", "hermes");
		const openclawCalls = join(root, "openclaw-mcp-calls.log");
		const { configPath: openclawConfigPath } = writeFakeOpenClawMcpBinary(home, {
			callsPath: openclawCalls,
		});
		const openclawUserSkill = join(
			home,
			".openclaw",
			"agents",
			"main",
			"skills",
			"user-skill",
			"SKILL.md",
		);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const paths = getRuntimePaths();
		mkdirSync(dirname(hermesBin), { recursive: true });
		mkdirSync(dirname(openclawUserSkill), { recursive: true });
		writeFileSync(
			openclawConfigPath,
			`${JSON.stringify(
				{
					custom: "keep",
					mcp: { servers: { "user-entry": { command: "user-owned", args: ["keep"] } } },
				},
				null,
				2,
			)}\n`,
		);
		writeFileSync(openclawUserSkill, "user-owned skill\n");
		writeHermesVersionBinary(home, "0.20.1");
		mkdirSync(join(home, ".hermes"), { recursive: true });
		writeFileSync(
			join(home, ".hermes", "config.yaml"),
			"mcp_servers:\n  user-entry:\n    command: user-owned\n    args:\n      - keep\n",
		);
		process.env.CLAWDI_AUTH_TOKEN = "deploy-key-secret";

		const load = (
			generation: number,
			selectedRuntime: "openclaw" | "hermes",
			servers: Record<string, ReturnType<typeof managedRemoteMcpServer>>,
			skillEnabled = true,
		): RuntimeManifestLoad => {
			const loaded = hostedSingleProviderModeLoad(home, selectedRuntime, "unmanaged", generation);
			loaded.manifest.workspaceRoot = workspace;
			loaded.manifest.projection = {
				...loaded.manifest.projection,
				mcp: { servers },
				skills: { entries: { clawdi: { enabled: skillEnabled, version: 1 } } },
			};
			loaded.secretValues = {
				...loaded.secretValues,
				...Object.fromEntries(
					Object.keys(servers).map((serverName) => [
						`secret://mcp/${serverName}`,
						`${serverName}-secret`,
					]),
				),
			};
			return loaded;
		};
		const initialServers = {
			clawdi: managedRemoteMcpServer("clawdi", "v1"),
			"search.proxy": managedRemoteMcpServer("search.proxy", "v1"),
		};
		const updatedServers = {
			...initialServers,
			"search.proxy": managedRemoteMcpServer("search.proxy", "v2"),
		};
		const loadWithSkillEntry = (
			skillId: string,
			entry: { enabled: boolean; version: number },
		): RuntimeManifestLoad => {
			const candidate = load(0, "openclaw", initialServers);
			return {
				...candidate,
				manifest: {
					...candidate.manifest,
					projection: {
						...candidate.manifest.projection,
						skills: { entries: { [skillId]: entry } },
					},
				},
			};
		};

		const unknownSkill = convergeAndCommitTestRuntimeManifest(
			loadWithSkillEntry("unknown", { enabled: true, version: 1 }),
			getRuntimePaths(),
		);
		expect(unknownSkill.installErrors).toEqual([]);
		expect(unknownSkill.resourceProjectionErrors.join("\n")).toContain(
			"no bundled hosted skill is registered for unknown",
		);
		const unknownSkillVersion = convergeAndCommitTestRuntimeManifest(
			loadWithSkillEntry("clawdi", { enabled: true, version: 2 }),
			getRuntimePaths(),
		);
		expect(unknownSkillVersion.installErrors).toEqual([]);
		expect(unknownSkillVersion.resourceProjectionErrors.join("\n")).toContain(
			"no bundled hosted skill clawdi version 2 is registered",
		);

		const openclawSkill = join(home, ".openclaw", "workspace", "skills", "clawdi");
		mkdirSync(openclawSkill, { recursive: true });
		writeFileSync(join(openclawSkill, "SKILL.md"), "local setup skill\n");
		reserveManagedSkill({
			targetDir: openclawSkill,
			id: "clawdi",
			version: 1,
			digest: "a".repeat(64),
			manager: "local-setup",
		});
		const collision = convergeAndCommitTestRuntimeManifest(
			load(1, "openclaw", initialServers),
			getRuntimePaths(),
		);
		expect(collision.installErrors).toEqual([]);
		expect(collision.resourceProjectionErrors.join("\n")).toContain(
			`refusing to replace unmanaged clawdi skill at ${openclawSkill}`,
		);
		expect(readFileSync(join(openclawSkill, "SKILL.md"), "utf-8")).toBe("local setup skill\n");
		releaseManagedSkill({
			targetDir: openclawSkill,
			id: "clawdi",
			manager: "local-setup",
			removeTarget: () => rmSync(openclawSkill, { recursive: true, force: true }),
		});

		const initial = convergeAndCommitTestRuntimeManifest(
			load(1, "openclaw", initialServers),
			getRuntimePaths(),
		);
		expect(initial.installErrors).toEqual([]);
		expect(readOpenClawMcpServers(home).clawdi).toEqual({
			...nativeManagedRemoteMcpServer("clawdi", "v1"),
			requestTimeoutMs: 420_000,
		});
		expect(readOpenClawMcpServers(home)["search.proxy"]).toEqual({
			...nativeManagedRemoteMcpServer("search.proxy", "v1"),
			requestTimeoutMs: 420_000,
		});
		expect(readOpenClawMcpServers(home)["user-entry"]).toEqual({
			command: "user-owned",
			args: ["keep"],
		});
		expect(
			JSON.parse(readFileSync(managedSkillReservationLedgerPath(), "utf-8")).reservations[
				openclawSkill
			],
		).toMatchObject({ id: "clawdi", manager: "hosted-manifest" });

		const installedSkill = readFileSync(join(openclawSkill, "SKILL.md"), "utf-8");
		writeFileSync(join(openclawSkill, "SKILL.md"), "tenant mutation before restart\n");
		rmSync(paths.configurationRoot, { recursive: true, force: true });
		const restarted = convergeAndCommitTestRuntimeManifest(
			load(1, "openclaw", initialServers),
			paths,
		);
		expect(restarted.installErrors).toEqual([]);
		expect(readFileSync(join(openclawSkill, "SKILL.md"), "utf-8")).toBe(installedSkill);
		expect(readOpenClawMcpServers(home).clawdi).toEqual({
			...nativeManagedRemoteMcpServer("clawdi", "v1"),
			requestTimeoutMs: 420_000,
		});

		const updated = convergeAndCommitTestRuntimeManifest(
			load(2, "openclaw", updatedServers),
			getRuntimePaths(),
		);
		expect(updated.installErrors).toEqual([]);
		expect(readOpenClawMcpServers(home)["search.proxy"]).toEqual({
			...nativeManagedRemoteMcpServer("search.proxy", "v2"),
			requestTimeoutMs: 420_000,
		});
		const updatedConfig = readFileSync(openclawConfigPath, "utf-8");
		const callsBeforeIdempotent = readFileSync(openclawCalls, "utf-8");
		const idempotent = convergeAndCommitTestRuntimeManifest(
			load(2, "openclaw", updatedServers),
			getRuntimePaths(),
		);
		expect(idempotent.installErrors).toEqual([]);
		expect(readFileSync(openclawConfigPath, "utf-8")).toBe(updatedConfig);
		expect(readFileSync(openclawCalls, "utf-8")).toBe(callsBeforeIdempotent);

		const switched = convergeAndCommitTestRuntimeManifest(
			load(3, "hermes", updatedServers),
			getRuntimePaths(),
		);
		expect(switched.installErrors).toEqual([]);
		expect(readOpenClawMcpServers(home).clawdi).toBeUndefined();
		expect(readOpenClawMcpServers(home)["search.proxy"]).toBeUndefined();
		expect(readOpenClawMcpServers(home)["user-entry"]).toEqual({
			command: "user-owned",
			args: ["keep"],
		});
		expect(existsSync(openclawSkill)).toBe(false);
		expect(readFileSync(openclawUserSkill, "utf-8")).toBe("user-owned skill\n");
		const hermesAfterSwitch = expectRecord(
			readHermesConfigYaml(home).mcp_servers,
			"Hermes MCP servers",
		);
		expect(hermesAfterSwitch["user-entry"]).toEqual({
			command: "user-owned",
			args: ["keep"],
		});
		expect(hermesAfterSwitch.clawdi).toEqual(nativeManagedRemoteMcpServer("clawdi", "v1"));
		expect(hermesAfterSwitch["search.proxy"]).toEqual(
			nativeManagedRemoteMcpServer("search.proxy", "v2"),
		);
		const hermesSkill = join(home, ".hermes", "skills", "clawdi");
		const hermesSkillReservation = JSON.parse(
			readFileSync(managedSkillReservationLedgerPath(), "utf-8"),
		).reservations[hermesSkill];
		expect(hermesSkillReservation).toMatchObject({
			id: "clawdi",
			manager: "hosted-manifest",
			digest: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		process.env.CLAWDI_RUNTIME_MODE = "local";
		expect(() =>
			convergeAndCommitTestRuntimeManifest(
				load(4, "hermes", updatedServers, true),
				getRuntimePaths(),
			),
		).toThrow("hosted convergence requires CLAWDI_RUNTIME_MODE=hosted explicitly");
		expect(existsSync(hermesSkill)).toBe(true);
		expect(readFileSync(openclawUserSkill, "utf-8")).toBe("user-owned skill\n");
		process.env.CLAWDI_RUNTIME_MODE = "hosted";

		const removedGeneric = convergeAndCommitTestRuntimeManifest(
			load(5, "hermes", { clawdi: initialServers.clawdi }, false),
			getRuntimePaths(),
		);
		expect(removedGeneric.installErrors).toEqual([]);
		const hermesAfterRemoval = expectRecord(
			readHermesConfigYaml(home).mcp_servers,
			"Hermes MCP servers",
		);
		expect(hermesAfterRemoval["search.proxy"]).toBeUndefined();
		expect(hermesAfterRemoval.clawdi).toEqual(nativeManagedRemoteMcpServer("clawdi", "v1"));
		expect(hermesAfterRemoval["user-entry"]).toEqual({
			command: "user-owned",
			args: ["keep"],
		});
		expect(existsSync(hermesSkill)).toBe(false);
		mkdirSync(hermesSkill, { recursive: true });
		writeFileSync(join(hermesSkill, "SKILL.md"), "user-owned canonical skill\n");

		const disabled = convergeAndCommitTestRuntimeManifest(
			load(6, "hermes", {}, false),
			getRuntimePaths(),
		);
		expect(disabled.installErrors).toEqual([]);
		const hermesAfterDisable = expectRecord(
			readHermesConfigYaml(home).mcp_servers,
			"Hermes MCP servers",
		);
		expect(hermesAfterDisable.clawdi).toBeUndefined();
		expect(hermesAfterDisable["user-entry"]).toEqual({
			command: "user-owned",
			args: ["keep"],
		});
		expect(readFileSync(join(hermesSkill, "SKILL.md"), "utf-8")).toBe(
			"user-owned canonical skill\n",
		);
		expect(readFileSync(openclawCalls, "utf-8")).toContain("unset search.proxy");
	});

	it("upgrades header-owned MCP state without a ledger and rejects an unmarked collision", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "workspace");
		const { configPath: openclawConfigPath } = writeFakeOpenClawMcpBinary(home);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const paths = getRuntimePaths();
		const desiredServer = managedRemoteMcpServer("clawdi", "v2");
		writeFileSync(
			openclawConfigPath,
			`${JSON.stringify({ mcp: { servers: { clawdi: nativeManagedRemoteMcpServer("clawdi", "v2") } } }, null, 2)}\n`,
		);
		ensureRuntimeStateDirs(paths);
		writeRuntimeAppliedState(
			{
				schemaVersion: "clawdi.runtimeAppliedState.v2",
				appliedAt: "2026-07-28T00:00:00.000Z",
				instanceId: "iid_mcp_ownership",
				etag: '"legacy-applied"',
				sourceRevision: "a".repeat(64),
				generation: 0,
				contentIdentity: { sourcePath: "legacy://0.13.x", sha256: "b".repeat(64) },
				activated: {},
				providerIds: [],
				projectedProviderIds: {},
			},
			paths,
		);
		const load = (generation: number): RuntimeManifestLoad => {
			const loaded = hostedSingleProviderModeLoad(home, "openclaw", "unmanaged", generation);
			loaded.manifest.instanceId = "iid_mcp_ownership";
			loaded.manifest.workspaceRoot = workspace;
			loaded.manifest.projection = {
				...loaded.manifest.projection,
				mcp: { servers: { clawdi: desiredServer } },
			};
			loaded.secretValues = {
				...loaded.secretValues,
				"secret://mcp/clawdi": "deploy-key-secret",
			};
			return loaded;
		};

		const upgraded = convergeAndCommitTestRuntimeManifest(load(1), paths);
		expect(upgraded.installErrors).toEqual([]);
		expect(readOpenClawMcpServers(home).clawdi).toMatchObject({
			url: desiredServer.url,
			requestTimeoutMs: 420_000,
		});

		writeFileSync(
			openclawConfigPath,
			'{"mcp":{"servers":{"clawdi":{"url":"https://user.test","transport":"streamable-http","headers":{"Authorization":"user-token"}}}}}\n',
		);
		expect(() => convergeRuntimeManifest(load(2), paths)).toThrow(
			/refusing to replace unmanaged openclaw MCP server clawdi/,
		);
	});

	it("claims MCP ownership only after successful mutations and retries failed cleanup", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "workspace");
		const calls = join(root, "openclaw-mcp-failure-calls.log");
		const failSet = join(root, "fail-set");
		const failUnset = join(root, "fail-unset");
		const { configPath: openclawConfigPath } = writeFakeOpenClawMcpBinary(home, {
			callsPath: calls,
			failSetFile: failSet,
			failUnsetFile: failUnset,
		});
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		writeFileSync(
			openclawConfigPath,
			`${JSON.stringify(
				{
					custom: "keep",
					mcp: { servers: { "user-owned": { command: "user", args: ["keep"] } } },
				},
				null,
				2,
			)}\n`,
		);

		const load = (
			generation: number,
			servers: Record<string, ReturnType<typeof managedRemoteMcpServer>>,
		): RuntimeManifestLoad => {
			const loaded = hostedSingleProviderModeLoad(home, "openclaw", "unmanaged", generation);
			loaded.manifest.workspaceRoot = workspace;
			loaded.manifest.projection = { ...loaded.manifest.projection, mcp: { servers } };
			loaded.secretValues = {
				...loaded.secretValues,
				...Object.fromEntries(
					Object.keys(servers).map((serverName) => [
						`secret://mcp/${serverName}`,
						`${serverName}-secret`,
					]),
				),
			};
			return loaded;
		};

		const beforeCollision = readFileSync(openclawConfigPath, "utf-8");
		expect(() =>
			convergeRuntimeManifest(
				load(1, { "user-owned": managedRemoteMcpServer("user-owned", "v1") }),
				getRuntimePaths(),
			),
		).toThrow(/refusing to replace unmanaged openclaw MCP server user-owned/);
		expect(readFileSync(openclawConfigPath, "utf-8")).toBe(beforeCollision);
		expect(existsSync(calls)).toBe(false);

		writeFileSync(failSet, "fail\n");
		const failedSet = convergeRuntimeManifest(
			load(2, { "failed-new": managedRemoteMcpServer("failed-new", "v1") }),
			getRuntimePaths(),
		);
		expect(failedSet.installErrors.join("\n")).toContain("runtime MCP projection failed");
		expect(readFileSync(openclawConfigPath, "utf-8")).toBe(beforeCollision);
		rmSync(failSet);

		const omittedAfterFailure = convergeRuntimeManifest(load(3, {}), getRuntimePaths());
		expect(omittedAfterFailure.installErrors).toEqual([]);
		expect(readFileSync(calls, "utf-8")).not.toContain("unset failed-new");

		const managed = convergeRuntimeManifest(
			load(4, { "owned-server": managedRemoteMcpServer("owned-server", "v1") }),
			getRuntimePaths(),
		);
		expect(managed.installErrors).toEqual([]);
		expect(readOpenClawMcpServers(home)["owned-server"]).toEqual({
			...nativeManagedRemoteMcpServer("owned-server", "v1"),
			requestTimeoutMs: 420_000,
		});

		writeFileSync(failUnset, "fail\n");
		const failedRemoval = convergeRuntimeManifest(load(5, {}), getRuntimePaths());
		expect(failedRemoval.installErrors.join("\n")).toContain("runtime MCP projection failed");
		expect(readOpenClawMcpServers(home)["owned-server"]).toEqual({
			...nativeManagedRemoteMcpServer("owned-server", "v1"),
			requestTimeoutMs: 420_000,
		});

		rmSync(failUnset);
		const retriedRemoval = convergeRuntimeManifest(load(6, {}), getRuntimePaths());
		expect(retriedRemoval.installErrors).toEqual([]);
		expect(readOpenClawMcpServers(home)["owned-server"]).toBeUndefined();
		expect(readOpenClawMcpServers(home)["user-owned"]).toEqual({
			command: "user",
			args: ["keep"],
		});
		expect(readFileSync(calls, "utf-8").match(/unset owned-server/g)).toHaveLength(2);
	});

	it("keeps provider secrets sidecar-only in the ephemeral run-dir config", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_RUNTIME_USER = TEST_PROCESS_USER;
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const loaded = hostedSingleProviderModeLoad(home, "openclaw", "configured", 1);
		loaded.manifest.runtimes.openclaw.install = undefined;
		const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());

		const paths = getRuntimePaths();
		const userUnitNames = convergence.outputs.systemdUserUnits.map((path) =>
			path.split("/").at(-1),
		);
		const systemUnitNames = convergence.outputs.systemdSystemUnits.map((path) =>
			path.split("/").at(-1),
		);
		const egressSecretPath = join(run, "secrets", "egress-secrets.json");
		const runtimeSidecarUnit = readSystemdSystemUnit(paths, "clawdi-runtime-sidecar");
		const runtimeSidecarEnv = readSystemdEnvFile(paths, "clawdi-runtime-sidecar");
		const transparentEgressEnv = readFileSync(paths.egressTransparentEnv, "utf-8");
		const openclawUnit = readSystemdUserServiceConfig(paths, "openclaw-gateway");
		const openclawEnv = readSystemdEnvFile(paths, "openclaw-gateway");
		expect(convergence.outputs.processManager).toBe("systemd");
		expect(convergence.outputs.systemdUserUnitRoot).toBe(join(home, ".config", "systemd", "user"));
		expect(convergence.outputs.systemdSystemUnitRoot).toBe(paths.systemdSystemRoot);
		expect(existsSync(join(state, "supervisor", "supervisord.conf"))).toBe(false);
		expect(userUnitNames).not.toContain("clawdi-runtime-sidecar.service");
		expect(systemUnitNames).toContain("clawdi-runtime-sidecar.service");
		expect(runtimeSidecarUnit).toContain(`ExecStart="${paths.cliManagedBin}" "runtime" "sidecar"`);
		expect(runtimeSidecarUnit).toContain(`Before=user@${TEST_PROCESS_UID}.service`);
		expect(runtimeSidecarEnv).toContain(`CLAWDI_EGRESS_ENV_FILE="${paths.egressTransparentEnv}"`);
		expect(transparentEgressEnv).toContain(`CLAWDI_RUNTIME_USER="${TEST_PROCESS_USER}"`);
		expect(transparentEgressEnv).toContain(`CLAWDI_RUNTIME_UID="${TEST_PROCESS_UID}"`);
		expect(transparentEgressEnv).toContain(`CLAWDI_RUNTIME_GID="${TEST_PROCESS_GID}"`);
		expect(transparentEgressEnv).toContain('CLAWDI_EGRESS_UID="10002"');
		expect(transparentEgressEnv).toContain('CLAWDI_EGRESS_GID="10002"');
		expect(transparentEgressEnv).toContain('CLAWDI_EGRESS_NFT_TABLE="clawdi_transparent_egress"');
		expect(transparentEgressEnv).toContain(
			`CLAWDI_EGRESS_PROFILE_BUNDLE="${getRuntimePaths().egressProfileBundle}"`,
		);
		expect(transparentEgressEnv).toContain(`CLAWDI_EGRESS_SECRET_FILE="${egressSecretPath}"`);
		expect(transparentEgressEnv).toContain(
			`CLAWDI_EGRESS_ENGINE_BINARY_PATH="${paths.egressServiceBinary}"`,
		);
		expect(transparentEgressEnv).toContain(`CLAWDI_EGRESS_ADDON_PATH="${paths.egressAddon}"`);
		expect(runtimeSidecarUnit).toContain(`ExecStart="${paths.cliManagedBin}" "runtime" "sidecar"`);
		expect(runtimeSidecarUnit).not.toContain("user=clawdi");
		expect(openclawUnit).not.toContain("\nExecStart=");
		expect(openclawUnit).not.toContain("\nWorkingDirectory=");
		expect(openclawUnit).not.toContain("user=clawdi");
		expect(openclawUnit).not.toContain("sk-managed-provider");
		expect(openclawEnv).toContain('CLAWDI_AI_API_KEY="clawdi-egress-placeholder"');
		expect(openclawEnv).not.toMatch(/^OPENAI_API_KEY=/m);
		expect(openclawEnv).not.toContain("sk-managed-provider");
		expect(openclawEnv).not.toContain(dirname(paths.cliManagedBin));
		expect(statSync(join(run, "secrets")).mode & 0o777).toBe(0o711);
		expect(existsSync(join(run, "secrets", "runtime-secrets.json"))).toBe(false);
		expect(existsSync(join(run, "secrets", "runtimes", "openclaw.json"))).toBe(false);
		expect(statSync(egressSecretPath).mode & 0o777).toBe(0o600);
		if (typeof process.getuid === "function" && process.getuid() === 0) {
			const openclawUnitPath = join(paths.systemdUserRoot, "openclaw-gateway.service");
			expect(statSync(openclawUnitPath).uid).toBe(10_001);
			expect(statSync(openclawUnitPath).gid).toBe(10_001);
			expect(statSync(egressSecretPath).uid).toBe(10002);
			expect(statSync(egressSecretPath).gid).toBe(10002);
		}
		const egressSecrets = JSON.parse(readFileSync(egressSecretPath, "utf-8"));
		expect(egressSecrets["secret://provider.clawdi-managed.apiKey"]).toBe("sk-managed-provider");
	});
});
