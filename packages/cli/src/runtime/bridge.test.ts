import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { RUNTIME_BRIDGE_COOKIE, startRuntimeBridge } from "./bridge";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
	await Promise.allSettled(closers.splice(0).map((close) => close()));
	delete process.env.CLAWDI_TEST_UPSTREAM_TOKEN;
});

function listen(server: ReturnType<typeof createServer>): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			const address = server.address();
			if (typeof address !== "object" || !address) {
				reject(new Error("server did not expose a TCP address"));
				return;
			}
			resolve(address.port);
		});
	});
}

function closeHttpServer(server: ReturnType<typeof createServer>): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

describe("runtime bridge", () => {
	it("rejects env-backed upstream headers when the env value is missing", async () => {
		await expect(
			startRuntimeBridge({
				token: "bridge-token",
				surfaces: [
					{
						name: "control",
						kind: "control-ui",
						listenHost: "127.0.0.1",
						listenPort: 0,
						upstreamHost: "127.0.0.1",
						upstreamPort: 1,
						upstreamHeaders: {},
						upstreamHeaderEnv: { Authorization: "CLAWDI_TEST_UPSTREAM_TOKEN" },
					},
				],
			}),
		).rejects.toThrow("Authorization requires CLAWDI_TEST_UPSTREAM_TOKEN");
	});

	it("rejects duplicate static and env-backed upstream header declarations", async () => {
		process.env.CLAWDI_TEST_UPSTREAM_TOKEN = "Bearer env-token";
		await expect(
			startRuntimeBridge({
				token: "bridge-token",
				surfaces: [
					{
						name: "control",
						kind: "control-ui",
						listenHost: "127.0.0.1",
						listenPort: 0,
						upstreamHost: "127.0.0.1",
						upstreamPort: 1,
						upstreamHeaders: { Authorization: "Bearer static-token" },
						upstreamHeaderEnv: { authorization: "CLAWDI_TEST_UPSTREAM_TOKEN" },
					},
				],
			}),
		).rejects.toThrow("duplicate upstream header declarations");
	});

	it("injects controlled upstream headers and strips bridge auth cookies", async () => {
		const upstreamHeaders: IncomingHttpHeaders[] = [];
		const upstream = createServer((req, res) => {
			upstreamHeaders.push(req.headers);
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("ok");
		});
		closers.push(() => closeHttpServer(upstream));
		const upstreamPort = await listen(upstream);
		process.env.CLAWDI_TEST_UPSTREAM_TOKEN = "Bearer env-token";

		const bridge = await startRuntimeBridge({
			token: "bridge-token",
			surfaces: [
				{
					name: "control",
					kind: "control-ui",
					listenHost: "127.0.0.1",
					listenPort: 0,
					upstreamHost: "127.0.0.1",
					upstreamPort,
					upstreamHeaders: { "X-Controlled": "fixed" },
					upstreamHeaderEnv: { Authorization: "CLAWDI_TEST_UPSTREAM_TOKEN" },
				},
			],
		});
		closers.push(() => bridge.close());

		const response = await fetch(`http://127.0.0.1:${bridge.surfaces[0]?.listenPort}/ui`, {
			headers: {
				Authorization: "Bearer client-token",
				Cookie: `${RUNTIME_BRIDGE_COOKIE}=bridge-token; theme=dark`,
				"X-Controlled": "client",
				"X-Forwarded-For": "198.51.100.1",
			},
		});

		expect(await response.text()).toBe("ok");
		const headers = upstreamHeaders[0];
		expect(headers?.authorization).toBe("Bearer env-token");
		expect(headers?.["x-controlled"]).toBe("fixed");
		expect(headers?.cookie).toBe("theme=dark");
		expect(headers?.["x-forwarded-for"]).toBeUndefined();
	});
});
