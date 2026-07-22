/**
 * Typed deploy-api types — re-exported from auto-generated
 * `deploy.generated.ts`. Regenerate with:
 *
 *     bun --cwd apps/web run generate-deploy-api
 *
 * The default source is the local hosted API on `:50021`. To regenerate
 * against a reviewed hosted worktree contract, run:
 *
 *     DEPLOY_OPENAPI_SOURCE=/path/to/clawdi-hosted/backend/openapi.json \
 *       bun --cwd apps/web run generate-deploy-api
 *
 * The generated file is intentionally a FILTERED subset of the hosted
 * deploy API OpenAPI surface — `scripts/filter-deploy-openapi.py` keeps only the
 * endpoints listed in its `KEEP_OPERATIONS_BY_PATH` allowlist plus their transitive
 * schema closure. Adding a new operation = adding it to that allowlist
 * + running the regen command. The filter also owns the documented narrow
 * forward overlay in `docs/plans/v2-declarative-dashboard-contract.md`.
 */
import type {
	components as GeneratedDeployComponents,
	paths as GeneratedDeployPaths,
} from "./deploy.generated";

export type DeployComponents = GeneratedDeployComponents;
export type DeployPaths = GeneratedDeployPaths;

type S = GeneratedDeployComponents["schemas"];

export type RuntimeUiAuthMode = "password" | "openclaw_device";
export type RuntimeUiCredentials = S["V2HostedRuntimeUiCredentials"];

export interface RuntimeUiEndpointInfo {
	runtime: "openclaw" | "hermes";
	role: "control_ui";
	url: string;
	auth_mode: RuntimeUiAuthMode;
	browser_mode: "top_level";
}

export type Deployment = S["V2HostedDeploymentReadResponse"];
export type DeploymentOperation = S["LongRunningOperation"];
export type DeploymentResource = S["HostedDeploymentResource"];
export type DeploymentUpdateRequest = S["V2UpdateDeploymentRequest"];
export type DeployRequestStatus = S["V2HostedDeployRequestReadResponse"];

export function isRuntimeUiEndpointInfo(value: unknown): value is RuntimeUiEndpointInfo {
	if (!isRecord(value)) return false;
	if ("requires_bridge_token" in value) return false;
	if (
		(value.runtime !== "openclaw" && value.runtime !== "hermes") ||
		value.role !== "control_ui" ||
		typeof value.url !== "string" ||
		value.browser_mode !== "top_level"
	) {
		return false;
	}
	if (
		(value.auth_mode !== "openclaw_device" && value.auth_mode !== "password") ||
		(value.runtime === "openclaw" && value.auth_mode !== "openclaw_device") ||
		(value.runtime === "hermes" && value.auth_mode !== "password")
	) {
		return false;
	}
	return isSafeRuntimeUiUrl(value.url, false);
}

export function isRuntimeUiCredentials(value: unknown): value is RuntimeUiCredentials {
	if (!isRecord(value) || (value.runtime !== "openclaw" && value.runtime !== "hermes"))
		return false;
	if (typeof value.url !== "string") return false;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
