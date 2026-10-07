import { afterAll, afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
	beginHermesConfigTransaction,
	commitHermesConfigTransaction,
	reconcileHermesConfigValue,
} from "./hermes-config";

import { runtimeFileCurrentRevision } from "./manifest-install";
import {
	preinstalledHermesConfigPath,
	resetPreinstalledProbesForTest,
} from "./preinstalled-probes";

const savedEnv = { ...process.env };
afterEach(() => {
	process.env = { ...savedEnv };
	resetPreinstalledProbesForTest();
});

const root = mkdtempSync(join(tmpdir(), "clawdi-hermes-config-test-"));
const mock = fileURLToPath(new URL("../test-support/hermes-config-cli-mock.ts", import.meta.url));

afterAll(() => rmSync(root, { recursive: true, force: true }));

test("merges a round of config patches into one comment-preserving write", () => {
	const commandLog = join(root, "commands.log");
	const command = join(root, "hermes");
	writeFileSync(
		command,
		`#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(commandLog)}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(mock)} "$@"\n`,
	);
	chmodSync(command, 0o755);

	const home = join(root, "managed");
	const configPath = join(home, ".hermes", "config.yaml");
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(
		configPath,
		"# operator-owned comment\nmcp_servers:\n  user.server:\n    command: user-owned\nplugins:\n  disabled:\n    - user/plugin\n",
	);
	const context = {
		command,
		home,
		cwd: home,
		environment: { HERMES_HOME: join(home, ".hermes") },
	};
	writeFileSync(commandLog, "");
	const before = readFileSync(configPath, "utf8");
	const transaction = beginHermesConfigTransaction(context);
	reconcileHermesConfigValue(transaction, "mcp_servers", {
		"user.server": { command: "user-owned" },
		"managed.server.with.dots": { command: "clawdi", args: ["mcp"] },
	});
	reconcileHermesConfigValue(transaction, "plugins.disabled", [
		"user/plugin",
		"dashboard_auth/nous",
	]);
	reconcileHermesConfigValue(transaction, "plugins.scan_on_install", false);
	expect(readFileSync(configPath, "utf8")).toBe(before);
	expect(commitHermesConfigTransaction(transaction)).toBe("committed");
	expect(readFileSync(configPath, "utf8")).toContain("# operator-owned comment");

	const config = parseYaml(readFileSync(configPath, "utf8")) as Record<string, unknown>;
	expect(config.mcp_servers).toEqual({
		"user.server": { command: "user-owned" },
		"managed.server.with.dots": { command: "clawdi", args: ["mcp"] },
	});
	expect(config.plugins).toEqual({
		disabled: ["user/plugin", "dashboard_auth/nous"],
		scan_on_install: false,
	});
	const commands = readFileSync(commandLog, "utf8").trim().split("\n");
	expect(commands).toEqual(["config path"]);

	const scalarParent = "dashboard: user-owned\n";
	writeFileSync(configPath, scalarParent);
	const invalid = beginHermesConfigTransaction(context);
	expect(() =>
		reconcileHermesConfigValue(invalid, "dashboard.basic_auth", { username: "admin" }),
	).toThrow("Hermes config field dashboard must be an object");
	expect(readFileSync(configPath, "utf8")).toBe(scalarParent);
});

test("defers a conflicting write and replays from the next config snapshot", () => {
	const command = join(root, "conflict-hermes");
	const home = join(root, "conflict");
	const configPath = join(home, ".hermes", "config.yaml");
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(
		command,
		`#!/bin/sh\nif [ "$*" = "config path" ]; then printf '%s\\n' ${JSON.stringify(configPath)}; fi\n`,
		{ mode: 0o755 },
	);
	writeFileSync(configPath, "# original\nmcp_servers: {}\n");
	const context = { command, home, cwd: home };
	const first = beginHermesConfigTransaction(context);
	reconcileHermesConfigValue(first, "plugins.scan_on_install", false);

	const userUpdate = "# user update\nmcp_servers:\n  user.server:\n    command: user-owned\n";
	writeFileSync(configPath, userUpdate);
	expect(commitHermesConfigTransaction(first)).toBe("conflict");
	expect(readFileSync(configPath, "utf8")).toBe(userUpdate);

	const replay = beginHermesConfigTransaction(context);
	reconcileHermesConfigValue(replay, "plugins.scan_on_install", false);
	expect(commitHermesConfigTransaction(replay)).toBe("committed");
	expect(readFileSync(configPath, "utf8")).toContain("# user update");
	expect(parseYaml(readFileSync(configPath, "utf8"))).toEqual({
		mcp_servers: { "user.server": { command: "user-owned" } },
		plugins: { scan_on_install: false },
	});
});

test("resolves named profile config through Hermes even when the default preinstalled probe matches", () => {
	const home = join(root, "preinstalled-home");
	const state = join(root, "preinstalled-state");
	const command = join(home, ".local", "bin", "hermes");
	const commandLog = join(home, "commands.log");
	const configPath = join(home, ".hermes", "config.yaml");
	const workConfigPath = join(home, ".hermes", "profiles", "work", "config.yaml");
	const gitDir = join(home, ".hermes", "hermes-agent", ".git");
	for (const path of [
		dirname(command),
		dirname(workConfigPath),
		gitDir,
		join(state, "preinstallation"),
	])
		mkdirSync(path, { recursive: true });
	writeFileSync(configPath, "# default config\n");
	writeFileSync(workConfigPath, "# work config\n");
	writeFileSync(
		command,
		`#!/bin/sh\nprintf '%s\\n' "$*" >> '${commandLog}'\nexec '${process.execPath}' '${mock}' "$@"\n`,
		{ mode: 0o755 },
	);
	const commit = "c".repeat(40);
	writeFileSync(join(gitDir, "HEAD"), `${commit}\n`);
	const executableRevision = runtimeFileCurrentRevision(command);
	if (!executableRevision) throw new Error("Hermes fixture revision is missing");
	const receipt = join(state, "preinstallation", "receipt.json");
	writeFileSync(
		receipt,
		JSON.stringify({
			probes: {
				runtime: "hermes",
				command,
				home,
				executableRevision,
				sourceIdentity: `git:${commit}`,
				version: "sealed version",
				configPath,
			},
		}),
		{ mode: 0o400 },
	);
	process.env.CLAWDI_RUNTIME_MODE = "hosted";
	process.env.CLAWDI_SERVICE_STATE_DIR = state;
	delete process.env.HERMES_HOME;
	resetPreinstalledProbesForTest(process.getuid?.() ?? 0);
	expect(preinstalledHermesConfigPath(command, home, executableRevision, undefined)).toBe(
		configPath,
	);
	const context = { command, home, cwd: home };
	expect(beginHermesConfigTransaction(context).path).toBe(configPath);
	expect(beginHermesConfigTransaction({ ...context, profile: "work" }).path).toBe(workConfigPath);
	const calls = readFileSync(commandLog, "utf8").trim().split("\n");
	expect(calls).toHaveLength(1);
	expect(calls[0]?.split(" ")).toEqual(expect.arrayContaining(["-p", "work", "config", "path"]));
});
