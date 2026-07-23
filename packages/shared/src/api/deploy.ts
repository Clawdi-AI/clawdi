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
export type RuntimeUiAuthMode = "password" | "openclaw_device";
export type RuntimeUiCredentials = S["V2HostedRuntimeUiCredentials"];
export type RuntimeUiEndpointInfo = S["V2HostedRuntimeUiEndpointInfo"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRuntimeUiEndpointInfo(value: unknown): value is RuntimeUiEndpointInfo {
	if (!isRecord(value)) return false;
	return (
		(value.runtime === "openclaw" || value.runtime === "hermes") &&
		value.role === "control_ui" &&
		typeof value.url === "string" &&
		(value.auth_mode === "openclaw_device" || value.auth_mode === "password") &&
		value.browser_mode === "top_level" &&
		(value.runtime === "openclaw"
			? value.auth_mode === "openclaw_device"
			: value.auth_mode === "password") &&
		isSafeRuntimeUiUrl(value.url, false)
	);
}

export function isRuntimeUiCredentials(value: unknown): value is RuntimeUiCredentials {
	if (!isRecord(value) || typeof value.url !== "string") return false;
	if (value.runtime === "hermes") {
		return (
			value.auth_mode === "password" &&
			value.username === "admin" &&
			typeof value.password === "string" &&
			Boolean(value.password.trim()) &&
			isSafeRuntimeUiUrl(value.url, false)
		);
	}
	return (
		value.runtime === "openclaw" &&
		value.auth_mode === "openclaw_device" &&
		(value.username === undefined || value.username === null) &&
		(value.password === undefined || value.password === null) &&
		isSafeRuntimeUiUrl(value.url, true)
	);
}

function isSafeRuntimeUiUrl(value: string, tokenFragment: boolean): boolean {
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.username || url.password || url.search) return false;
		if (!tokenFragment) return url.hash === "";
		const fragment = new URLSearchParams(url.hash.slice(1));
		return (
			url.hash.startsWith("#") &&
			fragment.getAll("token").length === 1 &&
			Boolean(fragment.get("token")?.trim()) &&
			[...fragment.keys()].every((key) => key === "token")
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
