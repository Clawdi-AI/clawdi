export interface CapturedRequest {
	url: string;
	path: string;
	method: string;
	headers: Record<string, string>;
	isMultipart: boolean;
	multipartFields?: Record<string, string>;
	body?: unknown;
}

/**
 * Install a fake global fetch that matches requests by (method, path prefix).
 *
 * Responses are returned by the first matching handler in `handlers`, or a
 * 404 if nothing matches. Every request (matched or not) is appended to the
 * returned `captured` array for after-the-fact assertions.
 */
export function mockFetch(
	handlers: Array<{
		method?: string;
		path: string | RegExp;
		response: (request: CapturedRequest) => Response | Promise<Response>;
	}>,
): { captured: CapturedRequest[]; restore: () => void } {
	const orig = globalThis.fetch;
	const captured: CapturedRequest[] = [];

	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		// openapi-fetch passes a Request object; legacy call sites pass a
		// string/URL + init. Normalise so either shape yields the same fields.
		const isRequest = input instanceof Request;
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		const method = (isRequest ? input.method : (init?.method ?? "GET")).toUpperCase();
		const path = url.replace(/^https?:\/\/[^/]+/, "");

		const headers = isRequest ? input.headers : new Headers(init?.headers);
		const capturedHeaders = Object.fromEntries(headers.entries());
		const contentType = headers.get("content-type") ?? "";
		const rawBody = isRequest ? input.body : init?.body;
		let multipart = rawBody instanceof FormData ? rawBody : null;
		if (!multipart && isRequest && contentType.includes("multipart/form-data")) {
			try {
				multipart = await input.clone().formData();
			} catch {
				// Keep the request observable even if the runtime cannot decode its body.
			}
		}
		const isMultipart = multipart !== null || contentType.includes("multipart/form-data");

		let body: unknown;
		let multipartFields: Record<string, string> | undefined;
		if (multipart) {
			multipartFields = {};
			for (const [key, value] of multipart.entries()) {
				if (typeof value === "string") multipartFields[key] = value;
			}
		}
		if (!isMultipart && contentType.includes("json")) {
			try {
				const text = isRequest ? await input.clone().text() : String(rawBody ?? "");
				body = text ? JSON.parse(text) : undefined;
			} catch {
				body = undefined;
			}
		}

		const request = {
			url,
			path,
			method,
			headers: capturedHeaders,
			isMultipart,
			multipartFields,
			body,
		};
		captured.push(request);

		for (const h of handlers) {
			if (h.method && h.method.toUpperCase() !== method) continue;
			const m = typeof h.path === "string" ? path.startsWith(h.path) : h.path.test(path);
			if (m) return await h.response(request);
		}
		return new Response(`unhandled ${method} ${path}`, { status: 404 });
	}) as typeof fetch;

	return {
		captured,
		restore: () => {
			globalThis.fetch = orig;
		},
	};
}
