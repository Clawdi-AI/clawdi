/** Shared by Expo's CommonJS build config and native runtime validation. */
function readLinkHosts(value) {
	if (value == null || value === "") return [];
	if (typeof value !== "string" || value.length > 4096) throw new Error("Invalid link hosts");
	const hosts = value.split(",").map((host) => host.trim().toLowerCase());
	if (
		hosts.length > 16 ||
		hosts.some(
			(host) =>
				host.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host),
		)
	)
		throw new Error("Invalid link hosts");
	return [...new Set(hosts)];
}

module.exports = { readLinkHosts };

// Shared by Android intent filters and Web's AASA components. Keep URL paths here.
const webLinkPaths = [
	{ path: "/" },
	...[
		"agents",
		"sessions",
		"projects",
		"skills",
		"memories",
		"vault",
		"vaults",
		"connectors",
		"channels",
		"ai-providers",
		"deploy",
		"terminal",
		"s",
		"share",
		"sign-in",
		"sign-up",
		"settings",
	].flatMap((root) => [{ path: `/${root}` }, { pathPrefix: `/${root}/` }]),
	{ path: "/vault-request" },
];
module.exports.webLinkPaths = webLinkPaths;

// Public machine-readable Web files must stay in a browser.
const agentFilePaths = {
	getStarted: "/get-started.md",
	legacyGuide: "/skill.md",
	skill: "/skills/clawdi/SKILL.md",
	discoveryIndex: "/.well-known/agent-skills/index.json",
	llms: "/llms.txt",
};
const webLinkExclusions = [...Object.values(agentFilePaths), "/skills/*/SKILL.md"];
const browserPathMatchers = webLinkExclusions.map(
	(pattern) =>
		new RegExp(
			`^${pattern
				.split("*")
				.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
				.join(".*")}$`,
		),
);
module.exports.agentFilePaths = agentFilePaths;
module.exports.webLinkExclusions = webLinkExclusions;
module.exports.isBrowserLinkPath = (path) =>
	browserPathMatchers.some((pattern) => pattern.test(path));
