import { fetch, ProxyAgent } from "undici";

const proxyUrl = process.env.CLAWDI_WA_SIDECAR_PROXY_URL;
const expectedIp = process.argv[2];
if (!proxyUrl || !expectedIp) throw new Error("proxy URL and expected public IP are required");
const dispatcher = new ProxyAgent(proxyUrl);
try {
	const response = await fetch("https://api.ipify.org", {
		dispatcher,
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) throw new Error(`egress probe returned HTTP ${response.status}`);
	const observedIp = (await response.text()).trim();
	if (observedIp !== expectedIp)
		throw new Error("egress public IP did not match the configured value");
} finally {
	await dispatcher.close();
}
