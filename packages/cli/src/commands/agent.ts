import type { components, Deployment } from "@clawdi/shared/api";
import chalk from "chalk";
import { ApiClient, ApiError, unwrap } from "../lib/api-client";
import { ClerkOAuthError } from "../lib/clerk-oauth";
import { requireUuid } from "../lib/cli-options";
import { emit } from "../lib/command-output";
import { HostedDeployClient } from "../lib/hosted-deploy-client";
import { confirmOrRequireYes } from "../lib/prompts";
import { requireAuth } from "../lib/require-auth";
import { sanitizeMetadata } from "../lib/sanitize";
import { type AgentRemoveOptions, removeCloudAgent } from "./agent-lifecycle";

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
	let deployments: Deployment[] | null = null;
	try {
		deployments = await new HostedDeployClient().getDeployments();
	} catch {
		console.error(
			"Could not load Cloud Agent deployment status. Kind and deployment status are unavailable; please retry or run `clawdi doctor`.",
		);
	}
	const inventory = agents.map((agent) => {
		const deployment = deployments?.find((item) => item.agent_id === agent.id);
		return {
			id: agent.id,
			name: agent.name,
			display_name: agent.display_name ?? null,
			agent_type: agent.agent_type,
			machine_name: agent.machine_name,
			last_seen_at: agent.last_seen_at,
			kind: deployments === null ? null : deployment ? "cloud" : "local",
			deployment_status: deployment?.resource.status?.summary_state ?? null,
		};
	});
	if (opts.json) {
		emit({
			schemaVersion: "clawdi.agentList.v1",
			agents: inventory,
		});
		return;
	}
	if (agents.length === 0) {
		console.log("No agents found.");
		return;
	}
	const headers = ["ID", "Name", "Type", "Machine", "Last activity", "Kind", "Deployment status"];
	const rows = inventory.map((agent) => [
		agent.id,
		sanitizeMetadata(agent.display_name || agent.name),
		sanitizeMetadata(agent.agent_type),
		sanitizeMetadata(agent.machine_name),
		sanitizeMetadata(agent.last_seen_at ?? "Never"),
		agent.kind ?? "-",
		sanitizeMetadata(agent.deployment_status ?? "-"),
	]);
	const widths = headers.map((header, index) =>
		Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
	);
	const line = (cells: string[]) =>
		cells.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join("  ");
	console.log(chalk.bold(line(headers)));
	for (const row of rows) console.log(line(row));
}

export async function agentRm(agentId: string, opts: AgentRemoveOptions = {}): Promise<void> {
	requireAuth();
	requireUuid(agentId, "Agent ID (from `clawdi agent list`)");
	if (opts.cancelSubscription && opts.keepSubscription)
		throw new Error("Choose either --cancel-subscription or --keep-subscription, not both.");
	if (
		!(await confirmOrRequireYes(
			`Remove agent ${agentId}? This archives a local agent's workspace or permanently deletes a Cloud Agent and its saved data.`,
			{
				yes: opts.yes,
				action:
					"remove this agent (archive a local workspace or permanently delete a Cloud Agent and its saved data)",
			},
		))
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
				await removeCloudAgent(agentId, opts);
				return;
			}
			if (error.status === 401 || error.isNetwork) throw error;
		}
		throw new Error("Could not remove the agent. Please retry or run `clawdi doctor`.");
	}
	if (opts.json) {
		emit(
			{
				schemaVersion: "clawdi.agentRm.v1",
				id: agentId,
				status: "disconnected",
			},
			false,
		);
	} else {
		console.log(`Disconnected agent ${agentId} and archived its workspace.`);
	}
}
