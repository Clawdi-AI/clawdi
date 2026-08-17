/**
 * Typed deploy-api types — re-exported from auto-generated
 * `deploy.generated.ts`. Regenerate with:
 *
 *     bun --cwd apps/web run generate-deploy-api
 *
 * The default source is the local hosted API on `:50021`. To regenerate
 * against the contract selected for a coordinated rollout, serve that OpenAPI
 * document locally and run:
 *
 *     DEPLOY_OPENAPI_SOURCE=http://localhost:50021/openapi.json \
 *       bun --cwd apps/web run generate-deploy-api
 *
 * The generated file is intentionally a FILTERED subset of the hosted
 * deploy API OpenAPI surface — `scripts/filter-deploy-openapi.py` keeps only the
 * endpoints listed in its `KEEP_OPERATIONS_BY_PATH` allowlist plus their transitive
 * schema closure. Adding a new operation = adding it to that allowlist
 * + running the regen command. See the filter script for details.
 */
import type { components as DeployComponents } from "./deploy.generated";

export type { components as DeployComponents, paths as DeployPaths } from "./deploy.generated";

type S = DeployComponents["schemas"];

export type DeploymentRead = S["V2HostedDeploymentReadResponse"];
export type Deployment = DeploymentRead;
export type DeployRequestRead = S["V2HostedDeployRequestReadResponse"];
export type DeploymentEventStreamSnapshotHandoff = S["EventStreamSnapshotHandoff"];
export type AiProviderRemovalImpact = S["V2AiProviderRemovalImpactResponse"];
export type AiProviderRemovalResult = S["V2AiProviderRemovalResponse"];
export type RuntimeUiCredentials =
	| S["V2HermesRuntimeUiCredentials"]
	| S["V2OpenClawRuntimeUiCredentials"];
export type RuntimeUiEndpointInfo =
	| S["V2HermesRuntimeUiEndpointInfo"]
	| S["V2OpenClawRuntimeUiEndpointInfo"];
export type RuntimeUiAuthMode = RuntimeUiEndpointInfo["auth_mode"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRuntimeUiEndpointInfo(value: unknown): value is RuntimeUiEndpointInfo {
	if (!isRecord(value)) return false;
	return (
		(value.runtime === "openclaw" || value.runtime === "hermes") &&
		value.role === "control_ui" &&
		typeof value.url === "string" &&
		(value.auth_mode === "openclaw_token" || value.auth_mode === "password") &&
		value.browser_mode === "embedded_and_top_level" &&
		(value.runtime === "openclaw"
			? value.auth_mode === "openclaw_token"
			: value.auth_mode === "password") &&
		isCleanRuntimeUiUrl(value.url)
	);
}

export function isRuntimeUiCredentials(value: unknown): value is RuntimeUiCredentials {
	if (
		!isRecord(value) ||
		typeof value.url !== "string" ||
		typeof value.deployment_resource_version !== "string" ||
		!value.deployment_resource_version
	) {
		return false;
	}
	if (value.runtime === "hermes") {
		return (
			value.auth_mode === "password" &&
			typeof value.username === "string" &&
			Boolean(value.username) &&
			typeof value.password === "string" &&
			Boolean(value.password) &&
			isCleanRuntimeUiUrl(value.url)
		);
	}
	return (
		value.runtime === "openclaw" &&
		value.auth_mode === "openclaw_token" &&
		typeof value.token === "string" &&
		Boolean(value.token) &&
		typeof value.handoff_url === "string" &&
		isOpenClawLaunchHandoff(value.handoff_url, value.url, value.token) &&
		isCleanRuntimeUiUrl(value.url)
	);
}

function isOpenClawLaunchHandoff(handoff: string, endpoint: string, token: string): boolean {
	if (handoff === `${endpoint}#token=${encodeURIComponent(token)}`) return true;
	try {
		const target = new URL(handoff);
		const cleanEndpoint = new URL(endpoint);
		const fragment = new URLSearchParams(target.hash.slice(1));
		const entries = [...fragment.entries()];
		target.hash = "";
		return (
			target.href === cleanEndpoint.href &&
			entries.length === 2 &&
			new Set(entries.map(([key]) => key)).size === 2 &&
			typeof fragment.get("bootstrapToken") === "string" &&
			Boolean(fragment.get("bootstrapToken")) &&
			fragment.get("bootstrapProfile") === "owner"
		);
	} catch {
		return false;
	}
}

function isCleanRuntimeUiUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			!url.username &&
			!url.password &&
			url.search === "" &&
			url.hash === ""
		);
	} catch {
		return false;
	}
}

export function isDeploymentEventStreamSnapshotHandoff(
	value: unknown,
): value is DeploymentEventStreamSnapshotHandoff {
	if (!isRecord(value)) return false;
	return (
		value.snapshot_isolation === "REPEATABLE READ" &&
		value.read_only === true &&
		Array.isArray(value.deployments) &&
		Array.isArray(value.operations) &&
		typeof value.event_stream_cursor === "string"
	);
}

export function unwrapDeploymentList(
	value: DeploymentRead[] | DeploymentEventStreamSnapshotHandoff,
): DeploymentRead[] {
	if (!Array.isArray(value)) {
		throw new Error("Unexpected event-stream handoff response for deployment list request");
	}
	return value;
}

export function unwrapDeploymentEventStreamSnapshotHandoff(
	value: DeploymentRead[] | DeploymentEventStreamSnapshotHandoff,
): DeploymentEventStreamSnapshotHandoff {
	if (!isDeploymentEventStreamSnapshotHandoff(value)) {
		throw new Error("Unexpected deployment list response for event-stream handoff request");
	}
	return value;
}
