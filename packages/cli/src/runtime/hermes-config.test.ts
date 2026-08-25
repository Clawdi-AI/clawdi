import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
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

	const upstreamHome = join(root, "upstream");
	mkdirSync(upstreamHome, { recursive: true });
	const inlineObject = '{"nested":true}';
	const upstreamSet = spawnSync(
		command,
		["config", "set", "--force", "contract.probe", inlineObject],
		{
			cwd: upstreamHome,
			env: { ...process.env, HOME: upstreamHome, HERMES_HOME: join(upstreamHome, ".hermes") },
		},
	);
	expect(upstreamSet.status).toBe(0);
	const upstreamConfig = parseYaml(
		readFileSync(join(upstreamHome, ".hermes", "config.yaml"), "utf8"),
	) as Record<string, unknown>;
	expect((upstreamConfig.contract as Record<string, unknown>).probe).toBe(inlineObject);

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
	expect(commands.length).toBeLessThanOrEqual(2);

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
