/**
 * Turn a FastAPI error payload into a readable one-liner.
 *
 * FastAPI packs the human message in `detail`; pydantic validation failures
 * come back as an array of `{loc, msg, type}`. Both web and CLI clients
 * flatten this the same way, so the logic lives here and both import it.
 */

type HasDetail = { detail: unknown };
type ValidationIssue = { loc?: unknown; msg?: unknown };

function hasDetailField(e: unknown): e is HasDetail {
	return typeof e === "object" && e !== null && "detail" in e;
}

function isRecord(v: unknown): v is ValidationIssue {
	return typeof v === "object" && v !== null;
}

function formatIssue(issue: unknown): string {
	if (!isRecord(issue)) return "";
	const loc = Array.isArray(issue.loc) ? issue.loc.join(".") : "";
	const msg = typeof issue.msg === "string" ? issue.msg : "";
	return loc ? `${loc}: ${msg}` : msg;
}

export function extractApiDetail(err: unknown): string {
	if (!hasDetailField(err)) {
		return typeof err === "string" ? err : JSON.stringify(err);
	}
	const detail = err.detail;
	if (typeof detail === "string") return detail;
	if (Array.isArray(detail)) {
		return detail.map(formatIssue).filter(Boolean).join("; ");
	}
	return JSON.stringify(err);
}
