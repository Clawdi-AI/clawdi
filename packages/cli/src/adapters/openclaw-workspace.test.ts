import { afterEach, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { OpenClawAdapter } from "./openclaw";
import {
	listOpenClawAgentWorkspaces,
	resolveOpenClawAgentWorkspace,
	resolveOpenClawAgentWorkspaceAsync,
} from "./openclaw-workspace";

const originalEnv = { ...process.env };
const originalPath = process.env.PATH;
let root = "";
afterEach(() => {
	process.env = { ...originalEnv };
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
});

function installRosterCommand(status = 0): string {
	root = mkdtempSync(join(tmpdir(), "openclaw-workspace-"));
	const bin = join(root, "bin");
	const command = join(bin, "openclaw");
	const roster = join(root, "roster.json");
	mkdirSync(bin, { recursive: true });
	writeFileSync(
		command,
		`#!/bin/sh
test "$*" = "agents list --json" || exit 1
cat "${roster}"
exit ${status}
`,
	);
	chmodSync(command, 0o755);
	process.env.PATH = `${bin}:${originalPath ?? ""}`;
	return roster;
}

test("resolves Skills from the official agent workspace roster", async () => {
	const roster = installRosterCommand();
	writeFileSync(
		roster,
		JSON.stringify([
			{ id: "main", workspace: join(root, "main-workspace") },
			{ id: "sales", workspace: join(root, "sales-workspace") },
		]),
	);

	expect(listOpenClawAgentWorkspaces()).toHaveLength(2);
	expect(resolveOpenClawAgentWorkspace()).toBe(join(root, "main-workspace"));
	expect(await resolveOpenClawAgentWorkspaceAsync()).toBe(join(root, "main-workspace"));
	process.env.OPENCLAW_AGENT_ID = " sales ";
	expect(resolveOpenClawAgentWorkspace()).toBe(join(root, "sales-workspace"));
	expect(await resolveOpenClawAgentWorkspaceAsync()).toBe(join(root, "sales-workspace"));
	expect(await resolveOpenClawAgentWorkspaceAsync("main")).toBe(join(root, "main-workspace"));
	const missingAgent = "OpenClaw agent missing is not present in the official agent roster";
	expect(() => resolveOpenClawAgentWorkspace("missing")).toThrow(missingAgent);
	await expect(resolveOpenClawAgentWorkspaceAsync("missing")).rejects.toMatchObject({
		message: missingAgent,
	});
});

test("resolves and collects Skills as the runtime user without tenant bins in PATH", async () => {
	const roster = installRosterCommand();
	const tenantBin = join(root, ".local", "bin");
	mkdirSync(tenantBin, { recursive: true });
	renameSync(join(root, "bin", "openclaw"), join(tenantBin, "openclaw"));
	const workspace = join(root, "official-workspace");
	const skillDir = join(workspace, "skills", "demo");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(join(skillDir, "SKILL.md"), "# Demo\n");
	writeFileSync(roster, JSON.stringify([{ id: "main", workspace }]));
	process.env.HOME = root;
	process.env.PATH = "/usr/local/bin:/usr/bin:/bin";
	process.env.CLAWDI_RUNTIME_USER = "fixture-agent";
	process.env.CLAWDI_RUNTIME_UID = String(process.getuid?.());
	process.env.CLAWDI_RUNTIME_GID = String(process.getgid?.());
	delete process.env.OPENCLAW_AGENT_ID;

	expect(resolveOpenClawAgentWorkspace()).toBe(workspace);
	expect(await resolveOpenClawAgentWorkspaceAsync()).toBe(workspace);
	const adapter = new OpenClawAdapter();
	expect(adapter.skills.rootDir()).toBe(join(workspace, "skills"));
	expect(await adapter.skills.listKeys()).toEqual(["demo"]);
	expect((await adapter.skills.collect()).map((skill) => skill.filePath)).toEqual([
		join(skillDir, "SKILL.md"),
	]);

	rmSync(join(tenantBin, "openclaw"));
	const message = "OpenClaw workspace resolution requires `openclaw agents list --json`";
	expect(() => adapter.skills.rootDir()).toThrow(message);
	await expect(adapter.skills.listKeys()).rejects.toThrow(message);
	await expect(adapter.skills.collect()).rejects.toThrow(message);
});

test.each([
	{ name: "malformed JSON", output: "not JSON", status: 0 },
	{ name: "empty roster", output: "[]", status: 0 },
	{
		name: "relative workspace",
		output: '[{"id":"main","workspace":"relative"}]',
		status: 0,
	},
	{ name: "nonzero exit", output: "fixture-sensitive-output", status: 1 },
])("rejects $name through both workspace resolvers", async ({ output, status }) => {
	const roster = installRosterCommand(status);
	writeFileSync(roster, output);
	const message = "OpenClaw workspace resolution requires `openclaw agents list --json`";
	expect(() => resolveOpenClawAgentWorkspace()).toThrow(message);
	await expect(resolveOpenClawAgentWorkspaceAsync()).rejects.toMatchObject({ message });
});

test("cancels an unresponsive roster read and joins its process before another command", async () => {
	const roster = installRosterCommand();
	const pidFile = join(root, "pid");
	const command = join(root, "bin", "openclaw");
	writeFileSync(
		command,
		`#!/bin/sh
trap '' TERM
echo $$ > "${pidFile}"
while :; do :; done
`,
	);
	const abort = new AbortController();
	const running = resolveOpenClawAgentWorkspaceAsync("main", abort.signal);
	const result = running.then(
		() => null,
		(error) => error,
	);
	try {
		for (let attempt = 0; attempt < 100 && !existsSync(pidFile); attempt++) await delay(10);
		expect(existsSync(pidFile)).toBe(true);
		const pid = Number(readFileSync(pidFile, "utf8").trim());
		abort.abort();
		expect(await result).toBeInstanceOf(Error);
		expect(() => process.kill(pid, 0)).toThrow();
		writeFileSync(
			command,
			`#!/bin/sh
cat "${roster}"
`,
		);
		writeFileSync(roster, JSON.stringify([{ id: "main", workspace: root }]));
		expect(await resolveOpenClawAgentWorkspaceAsync()).toBe(root);
	} finally {
		abort.abort();
		await result;
	}
});
