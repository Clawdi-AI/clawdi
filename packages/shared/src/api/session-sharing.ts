import type { components } from "./api.generated";
import { safeShareUrl } from "./project-sharing-state";

type Scope = NonNullable<components["schemas"]["SessionShareCreate"]["scope"]>;
export type SessionShareTarget =
	| { scope: "session" }
	| { scope: Exclude<Scope, "session">; position: number };

export function buildSessionShareRequest(
	target: SessionShareTarget,
): components["schemas"]["SessionShareCreate"] {
	if (target.scope === "session") return { scope: "session" };
	if (
		(target.scope !== "through" && target.scope !== "response") ||
		!Number.isSafeInteger(target.position) ||
		target.position < 0
	)
		throw new Error("Invalid Session share range");
	return { scope: target.scope, position: target.position };
}

export function sessionShareMatchesTarget(
	share: Pick<components["schemas"]["SessionShareResponse"], "scope" | "end_position">,
	target: SessionShareTarget,
) {
	return (
		share.scope === target.scope &&
		(target.scope === "session" || share.end_position === target.position)
	);
}

export function sessionShareIdentity(
	share: Pick<components["schemas"]["SessionShareListItemResponse"], "id" | "kind">,
) {
	return `${share.kind}:${share.id}`;
}

export function sessionShareScope(
	share: Pick<components["schemas"]["SessionShareListItemResponse"], "kind" | "scope">,
) {
	return share.scope;
}

/** Export links belong to the public Web share, never an authenticated API URL. */
export function sessionShareExportUrl(value: string, format: "md" | "json"): string | null {
	const safe = safeShareUrl(value);
	if (!safe) return null;
	const url = new URL(safe);
	if (!/\/s\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) || url.search || url.hash) return null;
	url.pathname = url.pathname.replace(/\/$/, "") + "." + format;
	return url.href;
}
