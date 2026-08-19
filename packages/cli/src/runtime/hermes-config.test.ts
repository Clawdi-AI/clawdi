import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { reconcileHermesConfigValue } from "./hermes-config";

const root = mkdtempSync(join(tmpdir(), "clawdi-hermes-config-test-"));
const mock = fileURLToPath(new URL("../test-support/hermes-config-cli-mock.ts", import.meta.url));

afterAll(() => rmSync(root, { recursive: true, force: true }));

test("reconciles structured values without relying on Hermes JSON parsing", () => {
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
	reconcileHermesConfigValue(context, "mcp_servers", {
		"user.server": { command: "user-owned" },
		"managed.server.with.dots": { command: "clawdi", args: ["mcp"] },
	});
	reconcileHermesConfigValue(context, "plugins.disabled", ["user/plugin", "dashboard_auth/nous"]);
	expect(readFileSync(configPath, "utf8")).toContain("# operator-owned comment");
	reconcileHermesConfigValue(context, "plugins.scan_on_install", false);

	const config = parseYaml(readFileSync(configPath, "utf8")) as Record<string, unknown>;
	expect(config.mcp_servers).toEqual({
		"user.server": { command: "user-owned" },
		"managed.server.with.dots": { command: "clawdi", args: ["mcp"] },
	});
	expect(config.plugins).toEqual({
		disabled: ["user/plugin", "dashboard_auth/nous"],
		scan_on_install: false,
	});
	const commands = readFileSync(commandLog, "utf8");
	expect(commands).toContain("config set --force contract.probe");
	expect(commands).toContain("config set --force plugins.scan_on_install false");
	expect(commands).not.toContain("config set --force mcp_servers");
	expect(commands).not.toContain("config set --force plugins.disabled");

	const scalarParent = "dashboard: user-owned\n";
	writeFileSync(configPath, scalarParent);
	expect(() =>
		reconcileHermesConfigValue(context, "dashboard.basic_auth", { username: "admin" }),
	).toThrow("Hermes config field dashboard must be an object");
	expect(readFileSync(configPath, "utf8")).toBe(scalarParent);
});
