export const VAULT_PROJECT_ACCESS_ERROR = "Vault resolve could not access the selected Project.";

export const VAULT_PROJECT_ACCESS_HINT =
	"If this is a shared Project, update the Clawdi backend so Viewers can use shared Vault runtime reads.";

export function isVaultProjectNotFoundBody(body: unknown): boolean {
	const parsed = parseBody(body);
	if (!isRecord(parsed) || !("detail" in parsed)) return false;
	const detail = parsed.detail;
	if (typeof detail === "string") {
		return detail.toLowerCase() === "project not found";
	}
	if (!isRecord(detail)) return false;
	const code = detail.code;
	if (code === "project_not_found") return true;
	const message = detail.message;
	return typeof message === "string" && message.toLowerCase() === "project not found";
}

function parseBody(body: unknown): unknown {
	if (typeof body !== "string") return body;
	try {
		return JSON.parse(body) as unknown;
	} catch {
		return body;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
