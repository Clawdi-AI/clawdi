import { HttpsProxyAgent } from "https-proxy-agent";
import { ProxyAgent } from "undici";

export type ProxyTransports = {
	agent: HttpsProxyAgent<string>;
	fetchAgent: HttpsProxyAgent<string>;
	dispatcher: ProxyAgent;
	close(): Promise<void>;
};

export function createProxyTransports(proxyUrl: string): ProxyTransports {
	let agent: HttpsProxyAgent<string> | undefined;
	let fetchAgent: HttpsProxyAgent<string> | undefined;
	try {
		agent = new HttpsProxyAgent(proxyUrl);
		fetchAgent = new HttpsProxyAgent(proxyUrl);
		const dispatcher = new ProxyAgent(proxyUrl);
		const transports = { agent, fetchAgent, dispatcher };
		return {
			...transports,
			async close() {
				transports.agent.destroy();
				transports.fetchAgent.destroy();
				await transports.dispatcher.close();
			},
		};
	} catch (error: unknown) {
		agent?.destroy();
		fetchAgent?.destroy();
		throw error;
	}
}
