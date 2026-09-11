import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request } from "node:http";
import { createServer } from "node:https";
import { connect } from "node:net";

const entry = process.env.OPENCLAW_TEST_ENTRY;
if (!entry) throw new Error("Missing isolated OpenClaw entry");
const state = `${process.env.HOME}/.openclaw`;
mkdirSync(state, { recursive: true });
writeFileSync(
	`${state}/openclaw.json`,
	JSON.stringify({
		gateway: {
			mode: "local",
			port: 18789,
			bind: "loopback",
			// The paired test's real Traefik ingress connects over loopback.
			trustedProxies: ["127.0.0.1"],
			auth: { mode: "token", token: "isolated-test-gateway-secret" },
			controlUi: {
				allowedOrigins: [
					"https://127.0.0.1:19443",
					"https://agent-42-18789.prod.clawdi.test:19444",
				],
			},
		},
		plugins: { enabled: false },
	}),
);
execFileSync(
	"openssl",
	[
		"req",
		"-x509",
		"-newkey",
		"rsa:2048",
		"-nodes",
		"-keyout",
		`${state}/key.pem`,
		"-out",
		`${state}/cert.pem`,
		"-days",
		"1",
		"-subj",
		"/CN=localhost",
	],
	{ stdio: "ignore" },
);
const gateway = spawn("node", [entry, "gateway", "run"], { stdio: "inherit" });
gateway.on("error", (error) => {
	console.error(error);
	process.exitCode = 1;
});
gateway.on("exit", (code) => {
	server.close();
	nativeProxy.close();
	process.exitCode = code ?? 1;
});
// Test-only ingress permits embedding. Official HTML/JS and native WS payloads
// are untouched. This is not evidence of production ingress configuration.
const observations = { privateHeaders: 0, nativeCookie: 0, forwardedNonLoopback: 0 };
function observe(req) {
	const forwarded = req.headers["x-forwarded-for"];
	if (typeof forwarded === "string" && !forwarded.startsWith("127.") && forwarded !== "::1")
		observations.forwardedNonLoopback += 1;
	if (
		req.headers.cookie?.includes("__Secure-clawdi_openclaw_owner=") ||
		req.headers.authorization === "Bearer dev-bypass" ||
		req.headers["x-clawdi-openclaw-route-proof"]
	)
		observations.privateHeaders += 1;
	if (req.headers.cookie?.includes("native-probe=preserved")) observations.nativeCookie += 1;
}
function serve(req, res) {
	if (req.url === "/__native_fixture__") {
		res.setHeader("Content-Type", "application/json");
		res.end(JSON.stringify(observations));
		return;
	}
	observe(req);
	const upstream = request(
		{ host: "127.0.0.1", port: 18789, path: req.url, method: req.method, headers: req.headers },
		(response) => {
			const headers = { ...response.headers };
			delete headers["x-frame-options"];
			if (headers["content-security-policy"])
				headers["content-security-policy"] = headers["content-security-policy"].replace(
					/frame-ancestors[^;]*(;|$)/g,
					"",
				);
			res.writeHead(response.statusCode ?? 502, headers);
			response.pipe(res);
		},
	);
	upstream.on("error", () => {
		res.writeHead(502);
		res.end();
	});
	req.pipe(upstream);
}
const server = createServer(
	{ key: readFileSync(`${state}/key.pem`), cert: readFileSync(`${state}/cert.pem`) },
	serve,
);
const nativeProxy = createHttpServer(serve);
function upgrade(req, socket, head) {
	observe(req);
	const upstream = connect(18789, "127.0.0.1", () => {
		upstream.write(
			`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${Object.entries(req.headers)
				.map(([key, value]) => `${key}: ${value}`)
				.join("\r\n")}\r\n\r\n`,
		);
		if (head.length) upstream.write(head);
		socket.pipe(upstream);
		upstream.pipe(socket);
	});
	upstream.on("error", () => socket.destroy());
	socket.on("error", () => upstream.destroy());
	socket.on("close", () => upstream.destroy());
}
server.on("upgrade", upgrade);
nativeProxy.on("upgrade", upgrade);
server.on("error", (error) => {
	console.error(error);
	gateway.kill();
	process.exitCode = 1;
});
process.on("SIGTERM", () => {
	server.close();
	nativeProxy.close();
	gateway.kill();
});
server.listen(19443, "127.0.0.1");

nativeProxy.listen(19446, "127.0.0.1");
