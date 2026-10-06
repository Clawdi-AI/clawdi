import { agentFilePaths } from "@clawdi/shared/linking";

/** Public file metadata shared by the route handlers and security middleware. */
export const AGENT_FILES = {
	getStarted: { path: agentFilePaths.getStarted, contentType: "text/markdown" },
	legacyGuide: { path: agentFilePaths.legacyGuide, contentType: "text/plain" },
	skill: {
		path: agentFilePaths.skill,
		contentType: "text/markdown",
		noindex: true,
		cors: true,
	},
	discoveryIndex: {
		path: agentFilePaths.discoveryIndex,
		contentType: "application/json",
		noindex: true,
		cors: true,
	},
	llms: { path: agentFilePaths.llms, contentType: "text/plain" },
} as const;

export type AgentFile = (typeof AGENT_FILES)[keyof typeof AGENT_FILES];
