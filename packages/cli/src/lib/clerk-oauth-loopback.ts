import { createServer, type Server } from "node:http";

type OAuthReturnTarget = "desktop" | "terminal";

function callbackResponse(
	status: "accepted" | "rejected",
	returnTarget: OAuthReturnTarget,
): string {
	const accepted = status === "accepted";
	const title = accepted ? "Login complete" : "Login not completed";
	const description =
		returnTarget === "desktop"
			? accepted
				? "You’re signed in. Return to Clawdi to continue."
				: "Sign-in wasn’t completed. Return to Clawdi and try again."
			: accepted
				? "You’re signed in. Close this window and return to your terminal."
				: "Sign-in wasn’t completed. Return to your terminal and run the login command again.";
	const icon = accepted ? '<path d="m7.5 12.5 3 3 6-7"/>' : '<path d="m8.5 8.5 7 7m0-7-7 7"/>';
	const role = accepted ? "status" : "alert";

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Clawdi · ${title}</title>
<style>
:root{color-scheme:light dark;--bg:oklch(0.975 0.004 85);--card:oklch(0.998 0.002 85);--text:oklch(0.22 0.008 70);--muted:oklch(0.49 0.012 70);--border:oklch(0.895 0.009 75);--status:${accepted ? "oklch(0.52 0.12 150)" : "oklch(0.54 0.19 27)"};--status-bg:${accepted ? "oklch(0.955 0.03 150)" : "oklch(0.955 0.027 27)"};--status-ring:${accepted ? "oklch(0.86 0.06 150)" : "oklch(0.86 0.065 27)"}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;min-height:100svh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--text);font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
main{width:min(100%,392px)}
.card{overflow:hidden;border:1px solid var(--border);border-radius:16px;background:var(--card);box-shadow:0 18px 50px -30px oklch(0.2 0.02 70/.42),0 2px 8px -4px oklch(0.2 0.02 70/.12)}
.content{padding:36px 34px 35px;text-align:center}
.icon{display:grid;place-items:center;width:46px;height:46px;margin:0 auto 20px;border:1px solid var(--status-ring);border-radius:50%;background:var(--status-bg);color:var(--status)}
.icon svg{width:23px;height:23px;fill:none;stroke:currentColor;stroke-width:2.15;stroke-linecap:round;stroke-linejoin:round}
h1{margin:0;font-size:25px;font-weight:680;line-height:1.22;letter-spacing:-.025em}
.description{margin:11px auto 0;max-width:300px;color:var(--muted);font-size:14.5px;line-height:1.55}
@media(max-width:440px){body{place-items:start center;padding:16px;padding-top:max(16px,12svh)}.content{padding:31px 23px 30px}.card{border-radius:14px}h1{font-size:23px}}
@media(prefers-color-scheme:dark){:root{--bg:oklch(0.16 0.006 70);--card:oklch(0.205 0.007 70);--text:oklch(0.93 0.006 75);--muted:oklch(0.67 0.01 75);--border:oklch(0.285 0.01 70);--status:${accepted ? "oklch(0.7 0.12 150)" : "oklch(0.7 0.17 27)"};--status-bg:${accepted ? "oklch(0.245 0.04 150)" : "oklch(0.25 0.045 27)"};--status-ring:${accepted ? "oklch(0.36 0.065 150)" : "oklch(0.37 0.075 27)"}}.card{box-shadow:0 20px 55px -32px oklch(0 0 0/.8),0 2px 8px -4px oklch(0 0 0/.5)}}
</style>
</head>
<body>
<main>
<section class="card" data-status="${status}" role="${role}" aria-labelledby="result-title" aria-describedby="result-description">
<div class="content">
<div class="icon" aria-hidden="true"><svg viewBox="0 0 24 24">${icon}</svg></div>
<h1 id="result-title">${title}</h1>
<p class="description" id="result-description">${description}</p>
</div>
</section>
</main>
</body>
</html>`;
}

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
	opts: { returnTarget?: OAuthReturnTarget } = {},
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
	const returnTarget = opts.returnTarget ?? "terminal";
	const callbackAcceptedResponse = callbackResponse("accepted", returnTarget);
	const callbackRejectedResponse = callbackResponse("rejected", returnTarget);
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
		response.end(status === 200 ? callbackAcceptedResponse : callbackRejectedResponse);
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
