import { auth } from "@clerk/tanstack-react-start/server";
import { env } from "@/lib/env";

const DEPLOYMENT_ID_PATTERN = /^[1-9][0-9]*$/;
const NO_STORE_HEADERS = {
	"cache-control": "no-store, private",
	pragma: "no-cache",
};

type FilesAuthorizeDependencies = {
	getToken: () => Promise<string | null>;
	fetch: (url: string, init: RequestInit) => Promise<Response>;
	deployApiUrl: string;
};

const productionDependencies: FilesAuthorizeDependencies = {
	getToken: async () => {
		if (env.VITE_DEV_AUTH_BYPASS) return env.VITE_DEV_AUTH_TOKEN;
		const clerk = await auth();
		return await clerk.getToken();
	},
	fetch,
	deployApiUrl: env.VITE_CLAWDI_DEPLOY_API_URL,
};

function errorResponse(status: number): Response {
	const message =
		status === 400
			? "Files return request is invalid."
			: status === 403
				? "Files access is not available for this agent."
				: status === 404
					? "Agent not found."
					: "Files is unavailable right now.";
	return new Response(message, {
		status,
		headers: {
			...NO_STORE_HEADERS,
			"content-type": "text/plain; charset=utf-8",
			"x-content-type-options": "nosniff",
		},
	});
}

export function sanitizeFilesReturnPath(value: string | null): string | null {
	if (
		!value ||
		value.length > 4096 ||
		!value.startsWith("/") ||
		value.startsWith("//") ||
		value.includes("\\") ||
		Array.from(value).some(
			(character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
		)
	) {
		return null;
	}
	try {
		const parsed = new URL(value, "https://files.invalid");
		if (parsed.origin !== "https://files.invalid" || parsed.hash) return null;
		return `${parsed.pathname}${parsed.search}`;
	} catch {
		return null;
	}
}

function exactFilesOrigin(value: unknown): string | null {
	if (typeof value !== "string") return null;
	try {
		const parsed = new URL(value);
		if (
			parsed.protocol !== "https:" ||
			parsed.username ||
			parsed.password ||
			parsed.pathname !== "/" ||
			parsed.search ||
			parsed.hash
		) {
			return null;
		}
		return parsed.origin;
	} catch {
		return null;
	}
}

function deploymentFilesOrigin(value: unknown, deploymentId: string): string | null {
	if (typeof value !== "object" || value === null) return null;
	const response = value as Record<string, unknown>;
	const resource = response.resource;
	if (typeof resource !== "object" || resource === null) return null;
	if ((resource as Record<string, unknown>).id !== deploymentId) return null;
	const endpoint = response.files_endpoint;
	if (typeof endpoint !== "object" || endpoint === null) return null;
	return exactFilesOrigin((endpoint as Record<string, unknown>).url);
}

function signedOutRedirect(requestUrl: URL): Response {
	const callback = `${requestUrl.pathname}${requestUrl.search}`;
	const search = new URLSearchParams({ redirect_url: callback });
	return new Response(null, {
		status: 302,
		headers: { ...NO_STORE_HEADERS, location: `/sign-in?${search}` },
	});
}

export async function GET(
	request: Request,
	dependencies: FilesAuthorizeDependencies = productionDependencies,
): Promise<Response> {
	const requestUrl = new URL(request.url);
	const deploymentId = requestUrl.searchParams.get("deployment_id");
	const returnPath = sanitizeFilesReturnPath(requestUrl.searchParams.get("return_to"));
	if (!deploymentId || !DEPLOYMENT_ID_PATTERN.test(deploymentId) || !returnPath) {
		return errorResponse(400);
	}

	let token: string | null;
	try {
		token = await dependencies.getToken();
	} catch {
		return errorResponse(503);
	}
	if (!token) return signedOutRedirect(requestUrl);

	let ownerResponse: Response;
	try {
		ownerResponse = await dependencies.fetch(
			`${dependencies.deployApiUrl.replace(/\/$/, "")}/v2/deployments/${deploymentId}`,
			{
				method: "GET",
				headers: {
					accept: "application/json",
					authorization: `Bearer ${token}`,
					"x-clawdi-platform": "web",
				},
				cache: "no-store",
				signal: AbortSignal.timeout(8_000),
			},
		);
	} catch {
		return errorResponse(503);
	}
	if (!ownerResponse.ok) {
		if (ownerResponse.status === 403) return errorResponse(403);
		if (ownerResponse.status === 404) return errorResponse(404);
		return errorResponse(503);
	}

	let payload: unknown;
	try {
		payload = await ownerResponse.json();
	} catch {
		return errorResponse(503);
	}
	const filesOrigin = deploymentFilesOrigin(payload, deploymentId);
	if (!filesOrigin) return errorResponse(403);
	const destination = new URL(returnPath, `${filesOrigin}/`);
	if (destination.origin !== filesOrigin) return errorResponse(400);

	return new Response(null, {
		status: 302,
		headers: { ...NO_STORE_HEADERS, location: destination.toString() },
	});
}
