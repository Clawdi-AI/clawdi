import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const environment = {
	...process.env,
	NODE_ENV: "production",
	NITRO_PRESET: "node-server",
	VITE_CLAWDI_HOSTED: "true",
	VITE_DEV_AUTH_BYPASS: "false",
	VITE_CLERK_PUBLISHABLE_KEY: "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==",
	CLERK_SECRET_KEY: "sk_test_fixture",
	CLERK_TELEMETRY_DISABLED: "1",
	VITE_CLAWDI_API_URL: "http://127.0.0.1:9",
	VITE_CLAWDI_DEPLOY_API_URL: "http://127.0.0.1:9",
	SENTRY_AUTH_TOKEN: "",
	VITE_SENTRY_DSN: "",
};
const build = spawnSync("bun", ["run", "build"], {
	cwd,
	env: environment,
	encoding: "utf8",
	maxBuffer: 16 * 1024 * 1024,
	timeout: 180_000,
});
assert.equal(build.status, 0, build.error?.message ?? build.stderr);

const reservation = createServer().listen(0, "127.0.0.1");
await once(reservation, "listening");
const address = reservation.address();
assert(address && typeof address === "object");
await new Promise((resolve) => reservation.close(resolve));
const server = spawn(process.execPath, [".output/server/index.mjs"], {
	cwd,
	env: { ...environment, NITRO_HOST: "127.0.0.1", NITRO_PORT: String(address.port) },
	stdio: ["ignore", "pipe", "pipe"],
});
const exited = once(server, "exit");
let shutdownDeadline;
function stopServer() {
	server.kill("SIGTERM");
	shutdownDeadline ??= setTimeout(() => server.kill("SIGKILL"), 5_000);
}
function cancel() {
	process.exitCode = 1;
	stopServer();
}
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
let logs = "";
for (const stream of [server.stdout, server.stderr]) {
	stream.on("data", (chunk) => {
		logs = (logs + chunk).slice(-64_000);
	});
}
try {
	for (const path of ["/sign-in", "/sign-up"]) {
		let response;
		for (let attempt = 0; attempt < 50; attempt++) {
			try {
				response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
					redirect: "manual",
					signal: AbortSignal.timeout(5_000),
				});
				break;
			} catch (error) {
				if (server.exitCode !== null || attempt === 49) throw error;
				await delay(100);
			}
		}
		assert.equal(response?.status, 200, `${path} SSR failed:\n${logs}`);
		assert.match(
			await response.text(),
			/window\.__clerk_init_state/,
			"Clerk SSR must render without an auth bypass",
		);
		console.log(`${path}: production Clerk SSR passed`);
	}
} finally {
	stopServer();
	try {
		await exited;
	} finally {
		clearTimeout(shutdownDeadline);
		process.off("SIGINT", cancel);
		process.off("SIGTERM", cancel);
	}
}
