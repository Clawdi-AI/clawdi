import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";

export interface OpenClawAgentWorkspace {
	id: string;
	workspace: string;
}

export function openClawAgentId(): string {
	return process.env.OPENCLAW_AGENT_ID?.trim() || "main";
}

export function parseOpenClawAgentWorkspaces(output: string): OpenClawAgentWorkspace[] {
	const parsed = JSON.parse(output) as unknown;
	if (!Array.isArray(parsed)) return [];
	return parsed.flatMap((value): OpenClawAgentWorkspace[] => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return [];
		const entry = value as Record<string, unknown>;
		return typeof entry.id === "string" &&
			typeof entry.workspace === "string" &&
			isAbsolute(entry.workspace)
			? [{ id: entry.id, workspace: entry.workspace }]
			: [];
	});
}

export function listOpenClawAgentWorkspaces(): OpenClawAgentWorkspace[] {
	const result = spawnSync("openclaw", ["agents", "list", "--json"], {
		encoding: "utf8",
		env: process.env,
		maxBuffer: 1024 * 1024,
		timeout: 15_000,
	});
	if (result.status === 0) {
		try {
			const summaries = parseOpenClawAgentWorkspaces(result.stdout);
			if (summaries.length > 0) return summaries;
		} catch {
			// Invalid public CLI output is reported below.
		}
	}
	throw new Error("OpenClaw workspace resolution requires `openclaw agents list --json`");
}

export function resolveOpenClawAgentWorkspace(agentId = openClawAgentId()): string {
	const workspace = listOpenClawAgentWorkspaces().find((entry) => entry.id === agentId)?.workspace;
	if (!workspace)
		throw new Error(`OpenClaw agent ${agentId} is not present in the official agent roster`);
	return workspace;
}
