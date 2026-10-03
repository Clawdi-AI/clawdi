import type { DeployComponents } from "./deploy";

type HostedWorkspaceSkillInstallRequest =
	DeployComponents["schemas"]["V2WorkspaceSkillInstallRequest"];
type HostedWorkspaceSkillListResponse = DeployComponents["schemas"]["V2WorkspaceSkillListResponse"];
type WorkspaceSkillStatusBoundary = Omit<HostedWorkspaceSkillListResponse, "capability"> & {
	capability?: HostedWorkspaceSkillListResponse["capability"];
};

function hasAsciiControlCharacter(value: string): boolean {
	return Array.from(value).some((character) => {
		const code = character.charCodeAt(0);
		return code <= 0x1f || code === 0x7f;
	});
}

export function workspaceSkillMutationsAvailable(
	status: WorkspaceSkillStatusBoundary | undefined,
	error: unknown,
): boolean {
	return !error && status?.capability?.available === true;
}

export function parseWorkspaceSkillGitHubInput(input: string): HostedWorkspaceSkillInstallRequest {
	const clean = input.trim();
	const decoded = decodeURIComponent(clean);
	if (
		decoded.includes("\\") ||
		hasAsciiControlCharacter(decoded) ||
		decoded.split("/").some((part) => part === "." || part === "..")
	)
		throw new Error("Enter a canonical GitHub repository path.");
	let repositoryPath: string;
	if (clean.includes("://")) {
		let url: URL;
		try {
			url = new URL(clean);
		} catch {
			throw new Error("Enter a valid GitHub repository URL.");
		}
		if (
			url.protocol !== "https:" ||
			url.host !== "github.com" ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		) {
			throw new Error("Enter a canonical github.com repository URL.");
		}
		try {
			repositoryPath = decodeURIComponent(url.pathname).replace(/\/$/, "").replace(/^\//, "");
		} catch {
			throw new Error("Enter a valid GitHub repository URL.");
		}
	} else {
		repositoryPath = clean.replace(/\/$/, "");
	}
	const parts = repositoryPath.split("/");
	const [owner, repo, ...pathParts] = parts;
	if (
		parts.length < 2 ||
		!owner ||
		!repo ||
		!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) ||
		!/^[A-Za-z0-9._-]{1,100}$/.test(repo) ||
		pathParts.some(
			(segment) =>
				!segment ||
				segment === "." ||
				segment === ".." ||
				segment.includes("\\") ||
				hasAsciiControlCharacter(segment),
		)
	) {
		throw new Error("Enter as `owner/repo` or `owner/repo/path-to-skill`.");
	}
	return {
		repo: `${owner}/${repo}`,
		path: pathParts.length > 0 ? pathParts.join("/") : undefined,
	};
}
