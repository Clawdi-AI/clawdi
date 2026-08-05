import { HttpsProxyAgent } from "https-proxy-agent";
import { ProxyAgent } from "undici";

export type ProxyTransports = {
	agent: HttpsProxyAgent<string>;
	fetchAgent: HttpsProxyAgent<string>;
	dispatcher: ProxyAgent;
	close(): Promise<void>;
};

export function createProxyTransports(proxyUrl: string): ProxyTransports {
	const agent = new HttpsProxyAgent(proxyUrl);
	const fetchAgent = new HttpsProxyAgent(proxyUrl);
	let dispatcher: ProxyAgent;
	try {
		dispatcher = new ProxyAgent(proxyUrl);
	} catch (error: unknown) {
		agent.destroy();
		fetchAgent.destroy();
		throw error;
	}
	return {
		agent,
		fetchAgent,
		dispatcher,
		async close() {
			agent.destroy();
			fetchAgent.destroy();
			await dispatcher.close();
		},
	};
}
