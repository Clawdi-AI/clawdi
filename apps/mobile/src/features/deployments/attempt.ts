import {
	type DeploymentMutation,
	type DeploymentUpdate,
	deploymentMutationHeaders,
	normalizeHostedDeployLanguage,
} from "@clawdi/shared/api";
import { type AttemptStore, createSerializedAttemptStore } from "../../platform/attempt-store";

export type RuntimeAttempt = {
	format: 1;
	deploymentId: string;
	key: string;
	version: string;
	mutation: DeploymentMutation;
	status: "prepared" | "uncertain" | "rejected";
};

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Validate the generated update shape without rebuilding it from a changing catalog.
function update(value: unknown): DeploymentUpdate | null {
	if (!record(value)) return null;
	const result: DeploymentUpdate = {};
	for (const [key, item] of Object.entries(value)) {
		switch (key) {
			case "runtime":
				if (item !== null && item !== "openclaw" && item !== "hermes") return null;
				result.runtime = item;
				break;
			case "language": {
				if (item === null) {
					result.language = null;
					break;
				}
				if (typeof item !== "string") return null;
				const language = normalizeHostedDeployLanguage(item);
				if (language !== item) return null;
				result.language = language;
				break;
			}
			case "timezone":
			case "ai_provider_id":
				if (item !== null && typeof item !== "string") return null;
				result[key] = item;
				break;
			case "ai_provider_auth_kind":
				if (
					item !== null &&
					item !== "unmanaged" &&
					item !== "managed" &&
					item !== "api_key" &&
					item !== "codex_oauth"
				)
					return null;
				result.ai_provider_auth_kind = item;
				break;
			case "provider_ids":
				if (
					item !== null &&
					(!Array.isArray(item) || !item.every((id): id is string => typeof id === "string"))
				)
					return null;
				result.provider_ids = item;
				break;
			case "ai_provider_bootstrap":
				if (item !== null && !record(item)) return null;
				result.ai_provider_bootstrap = item;
				break;
			case "primary_model":
				if (item === null) {
					result.primary_model = null;
					break;
				}
				if (
					!record(item) ||
					typeof item.provider_id !== "string" ||
					typeof item.model !== "string" ||
					Object.keys(item).some((field) => field !== "provider_id" && field !== "model")
				)
					return null;
				result.primary_model = { provider_id: item.provider_id, model: item.model };
				break;
			default:
				return null;
		}
	}
	return result;
}

export function parseRuntimeAttempt(raw: string): RuntimeAttempt | null {
	try {
		const value: unknown = JSON.parse(raw);
		if (
			record(value) &&
			Object.keys(value).some(
				(key) => !["format", "deploymentId", "key", "version", "mutation", "status"].includes(key),
			)
		)
			return null;
		if (
			!record(value) ||
			value.format !== 1 ||
			typeof value.deploymentId !== "string" ||
			!value.deploymentId ||
			typeof value.key !== "string" ||
			typeof value.version !== "string" ||
			!record(value.mutation)
		)
			return null;
		deploymentMutationHeaders(value.version, value.key);
		let mutation: DeploymentMutation;
		const action = value.mutation.action;
		if (action === "delete") {
			if (
				!record(value.mutation.body) ||
				value.mutation.body.subscription_choice !== "keep_subscription"
			)
				return null;
			mutation = { action, body: { subscription_choice: "keep_subscription" } };
		} else if (action === "update") {
			const body = update(value.mutation.body);
			if (!body) return null;
			mutation = { action, body };
		} else if (
			action === "start" ||
			action === "stop" ||
			action === "restart" ||
			action === "reset_runtime_ui_access"
		)
			mutation = { action };
		else return null;
		if (JSON.stringify(mutation) !== JSON.stringify(value.mutation)) return null;
		const status = value.status;
		if (status !== "prepared" && status !== "uncertain" && status !== "rejected") return null;
		return {
			format: 1,
			deploymentId: value.deploymentId,
			key: value.key,
			version: value.version,
			mutation,
			status,
		};
	} catch {
		return null;
	}
}

export function createRuntimeAttemptStore(store: AttemptStore) {
	return createSerializedAttemptStore(store, {
		parse: parseRuntimeAttempt,
		ownerError: "Runtime owner changed",
		sameIntent: (previous, next) =>
			previous.deploymentId === next.deploymentId &&
			previous.key === next.key &&
			previous.version === next.version &&
			JSON.stringify(previous.mutation) === JSON.stringify(next.mutation),
	});
}
