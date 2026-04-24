import { isAbsolute } from "node:path";

export type ParsedSource =
	| { type: "github"; owner: string; repo: string; path?: string; ref?: string }
	| { type: "gitlab"; owner: string; repo: string; path?: string; ref?: string }
	| { type: "ssh"; url: string }
	| { type: "https"; url: string }
	| { type: "local"; path: string };

/** Detect local file-system paths, including Windows drive letters. */
function isLocalPath(input: string): boolean {
	return (
		isAbsolute(input) ||
		input.startsWith("./") ||
		input.startsWith("../") ||
		input === "." ||
		input === ".." ||
		/^[a-zA-Z]:[/\\]/.test(input) // Windows absolute: C:\ or D:/
	);
}

/**
 * Parse a skill source into a structured descriptor.
 *
 * Accepted forms:
 *   - owner/repo[/subpath][#ref]
 *   - https://github.com/owner/repo[/tree/ref]/subpath
 *   - https://gitlab.com/owner/repo[/...]
 *   - git@github.com:owner/repo.git
 *   - Local absolute or relative path
 */
export function parseSource(input: string): ParsedSource {
	const trimmed = input.trim();

	if (isLocalPath(trimmed)) {
		return { type: "local", path: trimmed };
	}

	// SSH: git@host:owner/repo.git
	const sshMatch = trimmed.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
	if (sshMatch) {
		return { type: "ssh", url: trimmed };
	}

	// HTTPS URL
	if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
		try {
			const url = new URL(trimmed);
			const host = url.hostname;
			const parts = url.pathname
				.replace(/^\//, "")
				.replace(/\.git$/, "")
				.split("/");
			const [owner, repo] = parts;
			if (owner && repo) {
				// Handle GitHub's /tree/<ref>/subpath convention.
				let ref: string | undefined;
				let path: string | undefined;
				const treeIdx = parts.indexOf("tree");
				if (treeIdx === 2 && parts.length > 3) {
					ref = parts[3];
					if (parts.length > 4) path = parts.slice(4).join("/");
				} else if (parts.length > 2) {
					path = parts.slice(2).join("/");
				}
				if (host === "github.com") {
					return { type: "github", owner, repo, path, ref };
				}
				if (host === "gitlab.com") {
					return { type: "gitlab", owner, repo, path, ref };
				}
			}
			return { type: "https", url: trimmed };
		} catch {
			return { type: "https", url: trimmed };
		}
	}

	// owner/repo[/subpath][#ref] shorthand
	const [ownerRepoPath, ref] = trimmed.split("#");
	const segments = ownerRepoPath?.split("/").filter(Boolean) ?? [];
	const [owner, repo] = segments;
	if (owner && repo) {
		return {
			type: "github",
			owner,
			repo,
			path: segments.length > 2 ? segments.slice(2).join("/") : undefined,
			ref,
		};
	}

	throw new Error(
		`Unrecognized source "${input}". Expected owner/repo, a git URL, or a local path.`,
	);
}
