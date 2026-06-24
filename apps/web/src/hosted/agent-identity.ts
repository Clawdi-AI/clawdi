/**
 * Shared identity/naming helpers for hosted deployments and their cloud-api
 * agent environments. Centralized so the agent detail view, the agent-home
 * router, and the dashboard tile projection don't each carry their own copy.
 */

/**
 * A cloud-api environment id is a UUID. The post-deploy redirect can briefly
 * land on the agent route with a *deployment* id before env ids are minted, so
 * per-env queries (sessions, channel links) must gate on this to avoid firing
 * a 422 against `/api/sessions`.
 */
const CLOUD_ENV_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `value` looks like a real cloud-api env id (UUID), not a deployment id. */
export function isCloudEnvId(value: string): boolean {
	return CLOUD_ENV_ID_RE.test(value);
}

/**
 * Strip the hosted service's auto-generated `openclaw-` / `hermes-` app-slug
 * prefix from a deployment name. Every deployment gets the prefix regardless of which
 * runtimes are active, so it reads as misleading runtime metadata on a tile for
 * the other runtime. A user-given name (no prefix match) is kept intact.
 */
export function deploymentDisplayName(name: string): string {
	return name.replace(/^(openclaw|hermes)-/i, "") || name;
}
