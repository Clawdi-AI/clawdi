export function parseApiDetail(detail: string): unknown {
	try {
		const body = JSON.parse(detail) as { detail?: unknown };
		return body.detail ?? body;
	} catch {
		return detail;
	}
}

export function formatApiError(detail: string): string {
	const parsed = parseApiDetail(detail);
	if (typeof parsed === "string") return parsed;
	if (typeof parsed === "object" && parsed !== null && "message" in parsed) {
		const message = (parsed as { message?: unknown }).message;
		if (typeof message === "string") return message;
	}
	return detail;
}
