import type { HostedRuntime } from "@/hosted/runtimes";
import { runtimeDisplayName } from "@/hosted/runtimes";

/**
 * Shared identity/naming helpers for hosted deployments and their cloud-api
 * agent environments. Centralized so the agent detail view, the agent-home
 * router, and the dashboard tile projection don't each carry their own copy.
 */

/**
 * A cloud-api environment id is a UUID. The post-deploy redirect can briefly
 * land on the agent route with a *deployment* id before env ids are minted, so
 * per-env queries (sessions, channel links) must gate on this to avoid firing
 * a 422 against `/v1/sessions`.
 */
const CLOUD_ENV_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERATED_DEPLOYMENT_NAME_RE = /^deployment-create-/i;

/** Whether `value` looks like a real cloud-api env id (UUID), not a deployment id. */
export function isCloudEnvId(value: string): boolean {
	return CLOUD_ENV_ID_RE.test(value);
}

/**
 * Keep user-given deployment names intact while preserving the existing
 * runtime-prefix cleanup for generated runtime labels.
 */
export function deploymentDisplayName(name: string, runtime?: HostedRuntime): string {
	const fallback = runtime ? runtimeDisplayName(runtime) : "Clawdi Cloud agent";
	const trimmed = name.trim();
	if (!trimmed || GENERATED_DEPLOYMENT_NAME_RE.test(trimmed) || isCloudEnvId(trimmed)) {
		return fallback;
	}
	const cleaned = trimmed.replace(/^(codex|openclaw|hermes)-/i, "");
	return !cleaned || GENERATED_DEPLOYMENT_NAME_RE.test(cleaned) || isCloudEnvId(cleaned)
		? fallback
		: cleaned;
}
