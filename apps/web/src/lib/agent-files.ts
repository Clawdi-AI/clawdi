/** Public file metadata shared by the route handlers and security middleware. */
export const AGENT_FILES = {
	getStarted: { path: "/get-started.md", contentType: "text/markdown" },
	legacyGuide: { path: "/skill.md", contentType: "text/plain" },
	skill: {
		path: "/skills/clawdi/SKILL.md",
		contentType: "text/markdown",
		noindex: true,
		cors: true,
	},
	discoveryIndex: {
		path: "/.well-known/agent-skills/index.json",
		contentType: "application/json",
		noindex: true,
		cors: true,
	},
	setupPrompt: { path: "/agent-setup-prompt.txt", contentType: "text/plain", noindex: true },
	llms: { path: "/llms.txt", contentType: "text/plain" },
} as const;

export type AgentFile = (typeof AGENT_FILES)[keyof typeof AGENT_FILES];
