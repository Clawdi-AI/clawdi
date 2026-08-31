import { writeFileSync } from "node:fs";
import { createServer } from "node:http";

const [rawUrl, readyFile] = process.argv.slice(2);
if (!rawUrl || !readyFile) {
	throw new Error("usage: dashboard-smoke-server.mjs <loopback-url> <ready-file>");
}

const url = new URL(rawUrl);
if (
	url.protocol !== "http:" ||
	url.hostname !== "127.0.0.1" ||
	!url.port ||
	url.pathname !== "/" ||
	url.username ||
	url.password
) {
	throw new Error("loopback-url must be an HTTP 127.0.0.1 origin.");
}

const server = createServer((request, response) => {
	const requestUrl = new URL(request.url ?? "/", url);
	console.log(`${request.method} ${requestUrl.pathname}`);
	if (requestUrl.pathname === "/health") {
		response.writeHead(204).end();
		return;
	}
	if (requestUrl.pathname === "/redirect.js") {
		respond(response, "text/javascript; charset=utf-8", 'location.replace("/");');
		return;
	}
	if (requestUrl.pathname === "/ready.js") {
		respond(
			response,
			"text/javascript; charset=utf-8",
			'if (document.querySelector("h1")?.textContent === "Dashboard ready") fetch("/ready", { method: "POST" });',
		);
		return;
	}
	if (request.method === "POST" && requestUrl.pathname === "/ready") {
		writeFileSync(readyFile, "ready\n");
		response.writeHead(204).end();
		return;
	}
	if (requestUrl.pathname === "/desktop-auth") {
		respond(
			response,
			"text/html; charset=utf-8",
			'<!doctype html><title>Signing in</title><script src="/redirect.js"></script>',
		);
		return;
	}
	if (requestUrl.pathname === "/") {
		respond(
			response,
			"text/html; charset=utf-8",
			'<!doctype html><title>Dashboard</title><h1>Dashboard ready</h1><script src="/ready.js"></script>',
		);
		return;
	}
	response.writeHead(404).end();
});

server.listen(Number(url.port), url.hostname, () => console.log(`Listening on ${url.origin}`));
process.on("SIGTERM", () => server.close());

function respond(response, contentType, body) {
	response
		.writeHead(200, {
			"Cache-Control": "no-store",
			"Content-Type": contentType,
		})
		.end(body);
}
