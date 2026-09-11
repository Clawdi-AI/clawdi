import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
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
			auth: { mode: "token", token: "isolated-test-gateway-secret" },
			controlUi: { allowedOrigins: ["https://127.0.0.1:19443"] },
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
	process.exitCode = code ?? 1;
});
// Test-only ingress permits embedding. Official HTML/JS and native WS payloads
// are untouched. This is not evidence of production ingress configuration.
const server = createServer(
	{ key: readFileSync(`${state}/key.pem`), cert: readFileSync(`${state}/cert.pem`) },
	(req, res) => {
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
	},
);
server.on("upgrade", (req, socket, head) => {
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
});
server.on("error", (error) => {
	console.error(error);
	gateway.kill();
	process.exitCode = 1;
});
process.on("SIGTERM", () => {
	server.close();
	gateway.kill();
});
server.listen(19443, "127.0.0.1");
