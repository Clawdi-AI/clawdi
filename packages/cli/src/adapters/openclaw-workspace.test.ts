import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listOpenClawAgentWorkspaces, resolveOpenClawAgentWorkspace } from "./openclaw-workspace";

const originalPath = process.env.PATH;
let root = "";
afterEach(() => {
	process.env.PATH = originalPath;
	delete process.env.OPENCLAW_AGENT_ID;
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
});

test("resolves Skills from the official agent workspace roster", () => {
	root = mkdtempSync(join(tmpdir(), "openclaw-workspace-"));
	const bin = join(root, "bin");
	const command = join(bin, "openclaw");
	mkdirSync(bin, { recursive: true });
	writeFileSync(command, `#!/bin/sh
test "$*" = "agents list --json"
printf '%s\n' '[{"id":"main","workspace":"${root}/main-workspace"},{"id":"sales","workspace":"${root}/sales-workspace"}]'
`);
	chmodSync(command, 0o755);
	process.env.PATH = `${bin}:${originalPath ?? ""}`;

	expect(listOpenClawAgentWorkspaces()).toHaveLength(2);
	expect(resolveOpenClawAgentWorkspace()).toBe(join(root, "main-workspace"));
	process.env.OPENCLAW_AGENT_ID = "sales";
	expect(resolveOpenClawAgentWorkspace()).toBe(join(root, "sales-workspace"));
});
