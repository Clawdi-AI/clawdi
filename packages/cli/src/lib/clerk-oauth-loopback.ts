import { createServer, type Server } from "node:http";

const CALLBACK_RESPONSE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Clawdi login complete</title></head>
<body><main><h1>Clawdi login complete</h1><p>You can close this window and return to your terminal.</p></main></body>
</html>`;

const CALLBACK_REJECTED_RESPONSE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Clawdi login rejected</title></head>
<body><main><h1>Clawdi login rejected</h1><p>Return to your terminal and try again.</p></main></body>
</html>`;

export type ClerkOAuthLoopback = {
	callbackUrl: Promise<string>;
	close(): Promise<void>;
};

function listen(server: Server, port: number, hostname: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, hostname);
	});
}

function close(server: Server): Promise<void> {
	if (!server.listening) return Promise.resolve();
	return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Listen only on the exact registered loopback address. The callback code is
 * returned in memory and is never logged or written outside pending PKCE state.
 */
export async function startClerkOAuthLoopback(
	redirectUri: string,
	expectedState: string,
): Promise<ClerkOAuthLoopback> {
	const redirect = new URL(redirectUri);
	const port = Number.parseInt(redirect.port, 10);
	const hostname = redirect.hostname === "[::1]" ? "::1" : redirect.hostname;
	if (
		redirect.protocol !== "http:" ||
		!Number.isInteger(port) ||
		port < 1 ||
		port > 65_535 ||
		redirect.pathname !== "/oauth/callback" ||
		!(hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1")
	) {
		throw new Error("OAuth redirect URI is not an exact loopback address.");
	}

	let resolveCallback: (url: string) => void = () => {};
	let rejectCallback: (error: Error) => void = () => {};
	const callbackUrl = new Promise<string>((resolve, reject) => {
		resolveCallback = resolve;
		rejectCallback = reject;
	});
	let settled = false;
	const server = createServer((request, response) => {
		const requestUrl = new URL(request.url ?? "/", redirect);
		if (request.method !== "GET" || requestUrl.pathname !== redirect.pathname) {
			response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			response.end("Not found");
			return;
		}
		const callbackAccepted = requestUrl.searchParams.get("state") === expectedState;
		const authorizationDenied = requestUrl.searchParams.has("error");
		const code = requestUrl.searchParams.get("code")?.trim();
		const status = callbackAccepted && code && !authorizationDenied ? 200 : 400;
		response.writeHead(status, {
			"Cache-Control": "no-store",
			"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
			"Content-Type": "text/html; charset=utf-8",
			Pragma: "no-cache",
			"Referrer-Policy": "no-referrer",
			"X-Content-Type-Options": "nosniff",
		});
		response.end(status === 200 ? CALLBACK_RESPONSE : CALLBACK_REJECTED_RESPONSE);
		if (!callbackAccepted) return;
		if (!settled) {
			settled = true;
			resolveCallback(requestUrl.toString());
			void close(server);
		}
	});
	await listen(server, port, hostname);
	server.once("error", () => {
		if (!settled) {
			settled = true;
			rejectCallback(new Error("OAuth loopback listener failed."));
		}
	});

	return {
		callbackUrl,
		async close() {
			if (!settled) {
				settled = true;
				rejectCallback(new Error("OAuth loopback listener closed."));
			}
			await close(server);
		},
	};
}
