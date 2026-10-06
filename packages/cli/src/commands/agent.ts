import type { components } from "@clawdi/shared/api";
import chalk from "chalk";
import { ApiClient, ApiError, unwrap } from "../lib/api-client";
import { ClerkOAuthError } from "../lib/clerk-oauth";
import { requireUuid } from "../lib/cli-options";
import { confirmOrRequireYes } from "../lib/prompts";
import { requireAuth } from "../lib/require-auth";
import { sanitizeMetadata } from "../lib/sanitize";

export async function agentList(opts: { json?: boolean } = {}): Promise<void> {
	requireAuth();
	let agents: components["schemas"]["AgentResponse"][];
	try {
		agents = unwrap(await new ApiClient().GET("/v1/agents"));
	} catch (error) {
		if (error instanceof ClerkOAuthError) throw error;
		if (error instanceof ApiError) {
			if (error.status === 403) throw new Error("You do not have permission to list agents.");
			if (error.status === 401 || error.isNetwork) throw error;
		}
		throw new Error("Could not list agents. Please retry or run `clawdi doctor`.");
	}
	if (opts.json) {
		console.log(
			JSON.stringify(
				agents.map((agent) => ({
					id: agent.id,
					name: agent.name,
					display_name: agent.display_name ?? null,
					agent_type: agent.agent_type,
					machine_name: agent.machine_name,
					last_seen_at: agent.last_seen_at,
				})),
				null,
				2,
			),
		);
		return;
	}
	if (agents.length === 0) {
		console.log("No agents found.");
		return;
	}
	const headers = ["ID", "Name", "Type", "Machine", "Last activity"];
	const rows = agents.map((agent) => [
		agent.id,
		sanitizeMetadata(agent.display_name || agent.name),
		sanitizeMetadata(agent.agent_type),
		sanitizeMetadata(agent.machine_name),
		sanitizeMetadata(agent.last_seen_at ?? "Never"),
	]);
	const widths = headers.map((header, index) =>
		Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
	);
	const line = (cells: string[]) =>
		cells.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join("  ");
	console.log(chalk.bold(line(headers)));
	for (const row of rows) console.log(line(row));
}

export async function agentRm(
	agentId: string,
	opts: { yes?: boolean; json?: boolean } = {},
): Promise<void> {
	requireAuth();
	requireUuid(agentId, "Agent ID (from `clawdi agent list`)");
	if (
		!(await confirmOrRequireYes(`Disconnect agent ${agentId} and archive its workspace?`, {
			yes: opts.yes,
			action: "disconnect this agent and archive its workspace",
		}))
	)
		return;
	try {
		unwrap(
			await new ApiClient().DELETE("/v1/agents/{agent_id}", {
				params: { path: { agent_id: agentId } },
			}),
		);
	} catch (error) {
		if (error instanceof ClerkOAuthError) throw error;
		if (error instanceof ApiError) {
			if (error.status === 404) {
				throw new Error("Agent not found. Check the ID with `clawdi agent list`.");
			}
			if (error.status === 403) {
				throw new Error(
					"You do not have permission to remove this agent. API keys cannot remove agents; sign in with `clawdi auth login`.",
				);
			}
			if (error.status === 409) {
				throw new Error("This agent cannot be disconnected here. Manage it in the dashboard.");
			}
			if (error.status === 401 || error.isNetwork) throw error;
		}
		throw new Error("Could not remove the agent. Please retry or run `clawdi doctor`.");
	}
	console.log(
		opts.json
			? JSON.stringify({ id: agentId, status: "disconnected" })
			: `Disconnected agent ${agentId} and archived its workspace.`,
	);
}
