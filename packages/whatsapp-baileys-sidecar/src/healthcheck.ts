import { request } from "node:http";

const socketPath = required(process.env.CLAWDI_WA_SIDECAR_SOCKET_PATH, "socket path");
const token = required(process.env.CLAWDI_WA_SIDECAR_TOKEN, "sidecar token");
const accountId = required(process.env.CLAWDI_WA_PROVIDER_ACCOUNT_ID, "account id");

await new Promise<void>((resolve, reject) => {
	const healthRequest = request(
		{
			socketPath,
			path: "/v1/health",
			method: "GET",
			headers: { authorization: `Bearer ${token}` },
			timeout: 4_000,
		},
		(response) => {
			const chunks: Buffer[] = [];
			response.on("data", (chunk: Buffer) => chunks.push(chunk));
			response.on("end", () => {
				try {
					const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
					if (
						response.statusCode !== 200 ||
						typeof body !== "object" ||
						body === null ||
						!("accountId" in body) ||
						body.accountId !== accountId
					) {
						throw new Error("sidecar health identity mismatch");
					}
					resolve();
				} catch (error: unknown) {
					reject(error);
				}
			});
		},
	);
	healthRequest.once("timeout", () => healthRequest.destroy(new Error("sidecar health timeout")));
	healthRequest.once("error", reject);
	healthRequest.end();
});

function required(value: string | undefined, label: string): string {
	if (!value) throw new Error(`missing ${label}`);
	return value;
}
