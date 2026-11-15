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
printf '.\\n' >> "${join(root, "calls")}"
cat "${roster}"
exit ${status}
`,
	);
	chmodSync(command, 0o755);
	process.env.PATH = `${bin}:${originalPath ?? ""}`;
	return roster;
}

function rosterCalls(): number {
	return readFileSync(join(root, "calls"), "utf8").trim().split("\n").length;
}

test("Skills polls reuse a workspace within a reconcile cycle while reading current Skill keys", async () => {
	const roster = installRosterCommand();
	const workspace = join(root, "workspace");
	mkdirSync(join(workspace, "skills", "demo"), { recursive: true });
	writeFileSync(join(workspace, "skills", "demo", "SKILL.md"), "# Demo\n");
	writeFileSync(roster, JSON.stringify([{ id: "main", workspace }]));
	const skills = new OpenClawAdapter().skills;
	const context = { signal: new AbortController().signal, skillPollCycle: {} };
	expect(await skills.listKeys(context)).toEqual(["demo"]);
	for (let poll = 0; poll < 3; poll++) expect(await skills.listKeys(context)).toEqual(["demo"]);
	mkdirSync(join(workspace, "skills", "new"));
	writeFileSync(join(workspace, "skills", "new", "SKILL.md"), "# New\n");
	expect((await skills.listKeys(context)).sort()).toEqual(["demo", "new"]);
	expect(rosterCalls()).toBe(1);

	const nextWorkspace = join(root, "next-workspace");
	mkdirSync(nextWorkspace);
	writeFileSync(roster, JSON.stringify([{ id: "main", workspace: nextWorkspace }]));
	const nextCycle = { ...context, skillPollCycle: {} };
	expect(await skills.listKeys(nextCycle)).toEqual([]);
	expect(await skills.listKeys(nextCycle)).toEqual([]);
	expect(rosterCalls()).toBe(2);
});

test("a failed polling resolution is retried on the next poll", async () => {
	const roster = installRosterCommand(1);
	writeFileSync(roster, JSON.stringify([{ id: "main", workspace: root }]));
	const skills = new OpenClawAdapter().skills;
	const context = { signal: new AbortController().signal, skillPollCycle: {} };
	await expect(skills.listKeys(context)).rejects.toThrow("OpenClaw workspace resolution requires");
	expect(rosterCalls()).toBe(1);
	const command = join(root, "bin", "openclaw");
	writeFileSync(command, readFileSync(command, "utf8").replace(/\nexit 1\n$/, "\nexit 0\n"));
	expect(await skills.listKeys(context)).toEqual([]);
	expect(await skills.listKeys(context)).toEqual([]);
	expect(rosterCalls()).toBe(2);
});

test.each(["missing", "unreadable", "not a directory"])(
	"a %s cached workspace triggers fresh resolution",
	async (condition) => {
		const roster = installRosterCommand();
		const workspace = join(root, "workspace");
		const nextWorkspace = join(root, "next-workspace");
		mkdirSync(workspace);
		mkdirSync(nextWorkspace);
		writeFileSync(roster, JSON.stringify([{ id: "main", workspace }]));
		const cycle = {};
		expect(await resolveOpenClawAgentWorkspaceAsync("main", undefined, cycle)).toBe(workspace);
		if (condition === "unreadable") chmodSync(workspace, 0o000);
		else rmSync(workspace, { recursive: true });
		if (condition === "not a directory") writeFileSync(workspace, "unreadable as a directory");
		writeFileSync(roster, JSON.stringify([{ id: "main", workspace: nextWorkspace }]));
		try {
			expect(await resolveOpenClawAgentWorkspaceAsync("main", undefined, cycle)).toBe(
				nextWorkspace,
			);
			expect(await resolveOpenClawAgentWorkspaceAsync("main", undefined, cycle)).toBe(
				nextWorkspace,
			);
			expect(rosterCalls()).toBe(2);
		} finally {
			if (condition === "unreadable") chmodSync(workspace, 0o755);
		}
	},
);

test("one-shot Skills reads always resolve fresh even after a daemon poll", async () => {
	const roster = installRosterCommand();
	const workspace = join(root, "workspace");
	const nextWorkspace = join(root, "next-workspace");
	for (const path of [workspace, nextWorkspace]) {
		mkdirSync(join(path, "skills", "demo"), { recursive: true });
		writeFileSync(join(path, "skills", "demo", "SKILL.md"), "# Demo\n");
	}
	writeFileSync(roster, JSON.stringify([{ id: "main", workspace }]));
	const skills = new OpenClawAdapter().skills;
	const context = { signal: new AbortController().signal, skillPollCycle: {} };
	expect(await skills.listKeys(context)).toEqual(["demo"]);
	rmSync(join(workspace, "skills"), { recursive: true });
	writeFileSync(roster, JSON.stringify([{ id: "main", workspace: nextWorkspace }]));
	expect(await skills.listKeys(context)).toEqual([]);
	expect(await skills.listKeys()).toEqual(["demo"]);
	expect(await skills.listKeys()).toEqual(["demo"]);
	expect((await skills.collect(context)).map((skill) => skill.filePath)).toEqual([
		join(nextWorkspace, "skills", "demo", "SKILL.md"),
	]);
	expect(rosterCalls()).toBe(4);
});

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

	expect(await resolveOpenClawAgentWorkspaceAsync()).toBe(workspace);
	const adapter = new OpenClawAdapter();
	expect(await adapter.skills.listKeys()).toEqual(["demo"]);
	expect((await adapter.skills.collect()).map((skill) => skill.filePath)).toEqual([
		join(skillDir, "SKILL.md"),
	]);

	rmSync(join(tenantBin, "openclaw"));
	const message = "OpenClaw workspace resolution requires `openclaw agents list --json`";
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
