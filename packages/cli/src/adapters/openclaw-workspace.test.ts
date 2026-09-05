import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	listOpenClawAgentWorkspaces,
	resolveOpenClawAgentWorkspace,
	resolveOpenClawAgentWorkspaceAsync,
} from "./openclaw-workspace";

const originalPath = process.env.PATH;
let root = "";
afterEach(() => {
	process.env.PATH = originalPath;
	delete process.env.OPENCLAW_AGENT_ID;
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
