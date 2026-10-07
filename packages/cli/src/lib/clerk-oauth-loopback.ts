import { createServer, type Server } from "node:http";
import { ClerkOAuthError, exactLoopbackRedirectUri } from "./clerk-oauth";

type OAuthReturnTarget = "desktop" | "terminal";

function callbackResponse(
	status: "accepted" | "rejected",
	returnTarget: OAuthReturnTarget,
): string {
	const accepted = status === "accepted";
	const title = accepted ? "Authorization received" : "Sign-in not completed";
	const description =
		returnTarget === "desktop"
			? accepted
				? "Return to Clawdi to finish signing in."
				: "Sign-in wasn't completed. Return to Clawdi and try again."
			: accepted
				? "You're signed in. Close this window and return to your terminal."
				: "Sign-in wasn't completed. Return to your terminal and run the sign-in command again.";
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
		const onError = () => {
			server.off("listening", onListening);
			reject(
				new ClerkOAuthError(
					"oauth_loopback_unavailable",
					"Could not start Clawdi sign-in on port 18473. Close the other Clawdi sign-in and try again.",
				),
			);
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

function close(server: Server, force = false): Promise<void> {
	return new Promise((resolve) => {
		server.close(() => resolve());
		if (force) server.closeAllConnections();
	});
}

/** Bind only the registered IP literal; never log or persist the callback. */
export async function startClerkOAuthLoopback(
	redirectUri: string,
	expectedState: string,
	options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ClerkOAuthLoopback> {
	const redirect = new URL(exactLoopbackRedirectUri(redirectUri));
	const timeoutMs = options.timeoutMs ?? 5 * 60_000;
	if (!/^[A-Za-z0-9_-]{43}$/.test(expectedState) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new ClerkOAuthError(
			"invalid_oauth_callback",
			"Clawdi OAuth transaction is invalid. Start sign-in again.",
		);
	}
	if (options.signal?.aborted)
		throw new ClerkOAuthError("oauth_cancelled", "Clawdi sign-in was cancelled.");

	let resolveCallback: (url: string) => void = () => {};
	let rejectCallback: (error: Error) => void = () => {};
	const callbackUrl = new Promise<string>((resolve, reject) => {
		resolveCallback = resolve;
		rejectCallback = reject;
	});
	// A listener error/abort can precede the caller attaching its await.
	void callbackUrl.catch(() => undefined);
	let settled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const server = createServer((request, response) => {
		let requestUrl: URL;
		try {
			requestUrl = new URL(request.url ?? "/", redirect);
		} catch {
			response.writeHead(400);
			response.end("Invalid callback");
			return;
		}
		if (request.method !== "GET" || requestUrl.pathname !== redirect.pathname) {
			response.writeHead(404);
			response.end("Not found");
			return;
		}
		const validState =
			requestUrl.searchParams.getAll("state").length === 1 &&
			requestUrl.searchParams.get("state") === expectedState;
		const validRedirect =
			requestUrl.origin === redirect.origin &&
			!requestUrl.username &&
			!requestUrl.password &&
			!requestUrl.hash &&
			request.headers.host === redirect.host;
		const validParameters =
			requestUrl.searchParams.getAll("code").length <= 1 &&
			requestUrl.searchParams.getAll("error").length <= 1 &&
			!(requestUrl.searchParams.has("code") && requestUrl.searchParams.has("error"));
		const accepted = !settled && validState && validRedirect && validParameters;
		const success =
			accepted &&
			Boolean(requestUrl.searchParams.get("code")?.trim()) &&
			!requestUrl.searchParams.has("error");
		response.writeHead(success ? 200 : 400, {
			"Cache-Control": "no-store",
			"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
			"Content-Type": "text/html; charset=utf-8",
			Pragma: "no-cache",
			"Referrer-Policy": "no-referrer",
			"X-Content-Type-Options": "nosniff",
		});
		if (accepted) {
			settled = true;
			cleanup();
		}
		response.end(callbackResponse(success ? "accepted" : "rejected", "desktop"), () => {
			if (accepted) void close(server);
		});
		if (accepted) resolveCallback(requestUrl.toString());
	});
	server.requestTimeout = 5_000;
	server.headersTimeout = 5_000;

	function cleanup(): void {
		if (timer) clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
	}
	function fail(error: ClerkOAuthError): void {
		if (settled) return;
		settled = true;
		cleanup();
		rejectCallback(error);
		void close(server, true);
	}
	const abort = () => fail(new ClerkOAuthError("oauth_cancelled", "Clawdi sign-in was cancelled."));
	await listen(server, Number(redirect.port), redirect.hostname);
	server.once("error", () =>
		fail(
			new ClerkOAuthError("oauth_loopback_failed", "Clawdi sign-in listener failed. Try again."),
		),
	);
	timer = setTimeout(
		() =>
			fail(
				new ClerkOAuthError(
					"oauth_login_expired",
					"Clawdi sign-in timed out. Start sign-in again.",
				),
			),
		timeoutMs,
	);
	options.signal?.addEventListener("abort", abort, { once: true });
	if (options.signal?.aborted) abort();

	return {
		callbackUrl,
		async close() {
			fail(new ClerkOAuthError("oauth_cancelled", "Clawdi sign-in was cancelled."));
			cleanup();
			await close(server);
		},
	};
}
