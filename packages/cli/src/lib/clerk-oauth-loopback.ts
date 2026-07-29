import { createServer, type Server } from "node:http";

function callbackResponse(status: "accepted" | "rejected"): string {
	const accepted = status === "accepted";
	const title = accepted ? "Login complete" : "Login not completed";
	const description = accepted
		? "You’re signed in. Close this window and return to your terminal."
		: "Return to your terminal and run the login command again.";
	const icon = accepted ? '<path d="m7.5 12.5 3 3 6-7"/>' : '<path d="m8.5 8.5 7 7m0-7-7 7"/>';

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Clawdi · ${title}</title>
<style>
:root{color-scheme:light dark;--bg:oklch(0.985 0.0025 95);--card:oklch(0.998 0.001 95);--text:oklch(0.235 0.008 95);--muted:oklch(0.51 0.008 95);--border:oklch(0.91 0.005 95);--status:${accepted ? "oklch(0.56 0.105 150)" : "oklch(0.55 0.19 27)"};--status-bg:${accepted ? "oklch(0.96 0.022 150)" : "oklch(0.96 0.02 27)"}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;min-height:100svh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--text);font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{width:min(100%,420px)}
.brand{margin:0 0 16px;text-align:center;font-size:15px;font-weight:650;letter-spacing:-.01em}
.card{border:1px solid var(--border);border-radius:12px;background:var(--card);box-shadow:0 2px 4px -1px oklch(0.25 0.01 95/.05)}
.content{padding:40px;text-align:center}
.icon{display:grid;place-items:center;width:44px;height:44px;margin:0 auto 22px;border-radius:10px;background:var(--status-bg);color:var(--status)}
.icon svg{width:23px;height:23px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
h1{margin:0;font-size:27px;line-height:1.2;letter-spacing:-.03em}
.description{margin:13px auto 0;max-width:320px;color:var(--muted);font-size:15px;line-height:1.6}
@media(max-width:480px){body{padding:16px}.content{padding:34px 24px}h1{font-size:25px}}
@media(prefers-color-scheme:dark){:root{--bg:oklch(0.175 0.004 95);--card:oklch(0.205 0.004 95);--text:oklch(0.92 0.004 95);--muted:oklch(0.63 0.006 95);--border:oklch(0.275 0.005 95);--status:${accepted ? "oklch(0.66 0.11 150)" : "oklch(0.62 0.19 27)"};--status-bg:${accepted ? "oklch(0.24 0.035 150)" : "oklch(0.245 0.045 27)"}}}
</style>
</head>
<body>
<main>
<div class="brand">Clawdi</div>
<section class="card" aria-labelledby="result-title">
<div class="content">
<div class="icon" aria-hidden="true"><svg viewBox="0 0 24 24">${icon}</svg></div>
<h1 id="result-title">${title}</h1>
<p class="description">${description}</p>
</div>
</section>
</main>
</body>
</html>`;
}

const CALLBACK_RESPONSE = callbackResponse("accepted");
const CALLBACK_REJECTED_RESPONSE = callbackResponse("rejected");

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
