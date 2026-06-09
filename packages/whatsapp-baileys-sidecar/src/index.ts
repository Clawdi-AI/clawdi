import type { AddressInfo } from "node:net";

import { loadConfigFromEnv } from "./config.js";
import { BaileysSocketRuntime } from "./runtime.js";
import { createSidecarServer } from "./server.js";

const config = loadConfigFromEnv();
const runtime = new BaileysSocketRuntime(config);
const server = createSidecarServer(runtime, { apiToken: config.apiToken });

await runtime.start();

server.listen(config.port, config.host, () => {
	const address = server.address() as AddressInfo;
	console.log(
		JSON.stringify({
			event: "clawdi_whatsapp_baileys_sidecar_started",
			host: address.address,
			port: address.port,
			sessionDir: config.sessionDir,
		}),
	);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		server.close(() => {
			runtime
				.stop()
				.catch((error: unknown) => {
					console.error(error);
				})
				.finally(() => {
					process.exit(0);
				});
		});
	});
}
