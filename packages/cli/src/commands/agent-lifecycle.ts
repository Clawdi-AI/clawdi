import { randomUUID } from "node:crypto";
import * as p from "@clack/prompts";
import type { DeployComponents, HostedDeployOperation } from "@clawdi/shared/api";
import { computeFundingMode, isComputeSubscriptionRenewing } from "@clawdi/shared/view";
import { requireUuid } from "../lib/cli-options";
import { emitJson } from "../lib/command-output";
import { isAuthorizationRequired, mapHttpError } from "../lib/errors";
import { HostedDeployAuthorizationError } from "../lib/hosted-deploy-auth";
import { HostedDeployApiError, HostedDeployClient } from "../lib/hosted-deploy-client";
import { AuthorizationRequiredError, requireAuth } from "../lib/require-auth";
import { sanitizeMetadata } from "../lib/sanitize";
import { isInteractive } from "../lib/tty";

type LifecycleAction = "start" | "stop" | "restart";
type SubscriptionChoice =
	DeployComponents["schemas"]["V2DeleteDeploymentRequest"]["subscription_choice"];
export type AgentRemoveOptions = {
	yes?: boolean;
	json?: boolean;
	cancelSubscription?: boolean;
	keepSubscription?: boolean;
};

function cloudAgentError(error: unknown): never {
	if (error instanceof HostedDeployAuthorizationError) {
		const mapped = mapHttpError({ status: 0, code: error.code }, "Cloud Agent");
		if (mapped?.exitCode === 4) throw new AuthorizationRequiredError(mapped.message);
	}
	if (error instanceof HostedDeployApiError) {
		if (error.status === 0) throw error;
		const mapped = mapHttpError(error, "Cloud Agent");
		if (mapped?.exitCode === 4) throw new AuthorizationRequiredError(mapped.message);
		if (mapped) throw new Error(mapped.message);
		if (error.status === 404)
			throw new Error("Cloud Agent or operation not found. Check `clawdi agent list`.");
		if (error.status === 409 || error.status === 412 || error.status === 428)
			throw new Error(
				"Cloud Agent state changed or another operation is in progress. Check `clawdi agent list` before retrying.",
			);
		throw new Error("Could not manage the Cloud Agent. Please retry or run `clawdi doctor`.");
	}
	if (isAuthorizationRequired(error)) throw new AuthorizationRequiredError(error.message);
	throw error;
}

function checkOperation(operation: HostedDeployOperation): void {
	if (operation.error)
		throw new Error(
			`Cloud Agent operation ${sanitizeMetadata(operation.name)} failed. Check \`clawdi agent list\` before retrying.`,
		);
}

// Match deploy's bounded one-second polling window, without retrying mutations.
async function waitForOperation(client: HostedDeployClient, initial: HostedDeployOperation) {
	let operation = initial;
	for (let poll = 0; poll <= 1_200; poll += 1) {
		checkOperation(operation);
		if (operation.done) return operation;
		if (poll === 1_200) break;
		if (poll === 0)
			console.error(`Waiting for Cloud Agent operation ${sanitizeMetadata(operation.name)}…`);
		await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
		operation = await client.getOperation(operation.name);
	}
	throw new Error(
		`Cloud Agent operation ${sanitizeMetadata(operation.name)} is still pending. Check \`clawdi agent list\` before retrying.`,
	);
}

export async function agentLifecycle(
	action: LifecycleAction,
	agentId: string,
	opts: { json?: boolean; wait?: boolean } = {},
): Promise<void> {
	requireAuth();
	requireUuid(agentId, "Agent ID (from `clawdi agent list`)");
	try {
		const client = new HostedDeployClient();
		const deployment = await client.getAgentDeployment(agentId);
		let operation = await client.changeDeploymentLifecycle(
			deployment.resource.id,
			action,
			deployment.resource.metadata.resourceVersion,
			randomUUID(),
		);
		checkOperation(operation);
		if (opts.wait !== false) operation = await waitForOperation(client, operation);
		const status = operation.done ? "succeeded" : "accepted";
		if (opts.json) {
			emitJson(
				{
					schemaVersion: `clawdi.agent${action[0]?.toUpperCase()}${action.slice(1)}.v1`,
					id: agentId,
					deployment_id: deployment.resource.id,
					operation_name: operation.name,
					status,
				},
				false,
			);
		} else {
			console.log(
				`Cloud Agent ${agentId}: ${action} ${status}. Operation: ${sanitizeMetadata(operation.name)}.`,
			);
		}
	} catch (error) {
		cloudAgentError(error);
	}
}

export async function removeCloudAgent(agentId: string, opts: AgentRemoveOptions): Promise<void> {
	try {
		const client = new HostedDeployClient();
		const deployment = await client.getAgentDeployment(agentId);
		const subscription = deployment.commercial_display?.compute_subscription;
		const fundingMode = computeFundingMode(deployment.current_plan_slug, subscription);
		const offerChoice =
			fundingMode === "subscription" && isComputeSubscriptionRenewing(subscription);
		let choice: SubscriptionChoice = opts.cancelSubscription
			? "cancel_subscription"
			: opts.keepSubscription
				? "keep_subscription"
				: fundingMode === "included_basic"
					? "cancel_subscription"
					: "keep_subscription";
		if (offerChoice && !opts.cancelSubscription && !opts.keepSubscription) {
			if (!isInteractive())
				throw new Error(
					"This Cloud Agent has a renewing subscription. Re-run with --yes and either --cancel-subscription or --keep-subscription.",
				);
			const selected = await p.select<SubscriptionChoice>({
				message:
					"Delete this Cloud Agent and its saved data. What should happen to its subscription?",
				output: process.stderr,
				initialValue: "cancel_subscription",
				options: [
					{ value: "cancel_subscription", label: "Cancel subscription" },
					{ value: "keep_subscription", label: "Keep subscription for a future agent" },
				],
			});
			if (p.isCancel(selected)) {
				p.cancel("Cancelled.", { output: process.stderr });
				return;
			}
			choice = selected;
		}
		const result = await client.deleteDeployment(
			deployment.resource.id,
			{ subscription_choice: choice },
			deployment.resource.metadata.resourceVersion,
			randomUUID(),
		);
		const operation = "name" in result ? result : null;
		if (operation) checkOperation(operation);
		const status = operation && !operation.done ? "accepted" : "deleted";
		if (opts.json) {
			emitJson(
				{
					schemaVersion: "clawdi.agentRm.v1",
					id: agentId,
					status,
					deployment_id: deployment.resource.id,
					operation_name: operation?.name ?? null,
					subscription_choice: choice,
				},
				false,
			);
		} else {
			console.log(
				status === "accepted"
					? `Cloud Agent ${agentId} deletion accepted. Check \`clawdi agent list\` for completion. Operation: ${sanitizeMetadata(operation?.name ?? "")}.`
					: `Deleted Cloud Agent ${agentId}.`,
			);
		}
	} catch (error) {
		cloudAgentError(error);
	}
}
