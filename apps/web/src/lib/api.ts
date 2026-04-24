export const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

/** Build a full backend URL — use when you need raw `fetch` (e.g. streaming, non-JSON bodies). */
export const apiUrl = (path: string): string => `${API_URL}${path}`;

export class ApiError extends Error {
	constructor(
		public status: number,
		public detail: string,
	) {
		super(`API ${status}: ${detail}`);
		this.name = "ApiError";
	}
}

export async function apiFetch<T>(path: string, token: string, options?: RequestInit): Promise<T> {
	const res = await fetch(apiUrl(path), {
		...options,
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			...options?.headers,
		},
	});

	if (!res.ok) {
		const body = await res.text();
		let detail = body;
		try {
			// FastAPI puts the human message in `detail`. 4xx from pydantic validation
			// returns it as an array of {loc, msg, type} objects — join into a readable line.
			const parsed = JSON.parse(body);
			if (parsed && typeof parsed.detail === "string") {
				detail = parsed.detail;
			} else if (parsed && Array.isArray(parsed.detail)) {
				detail = parsed.detail
					.map((e: { loc?: unknown[]; msg?: string }) => {
						const loc = Array.isArray(e.loc) ? e.loc.join(".") : "";
						return loc ? `${loc}: ${e.msg ?? ""}` : (e.msg ?? "");
					})
					.filter(Boolean)
					.join("; ");
			}
		} catch {
			// body wasn't JSON — fall back to the raw text
		}
		throw new ApiError(res.status, detail);
	}

	return res.json() as Promise<T>;
}
