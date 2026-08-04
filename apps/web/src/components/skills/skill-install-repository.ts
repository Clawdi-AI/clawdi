export function parseSkillRepository(value: string): { repo: string; path?: string } | null {
	const trimmed = value.trim();
	if (!trimmed) return null;

	let repositoryPath = trimmed;
	if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) {
		let url: URL;
		try {
			url = new URL(trimmed);
		} catch {
			return null;
		}
		if (
			url.protocol !== "https:" ||
			url.hostname.toLowerCase() !== "github.com" ||
			url.username ||
			url.password ||
			url.port ||
			url.search ||
			url.hash
		) {
			return null;
		}
		repositoryPath = url.pathname;
	} else if (/[?#\\]/.test(trimmed)) {
		return null;
	}

	const clean = repositoryPath.replace(/^\/+|\/+$/g, "");
	const parts = clean.split("/");
	if (parts.length < 2) return null;
	const [owner, repo, ...pathParts] = parts;
	if (!owner || !repo || !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(owner)) return null;
	if (!/^[a-z\d._-]+$/i.test(repo)) return null;
	if (pathParts.some((part) => !part || part === "." || part === "..")) return null;
	return {
		repo: `${owner}/${repo}`,
		path: pathParts.length > 0 ? pathParts.join("/") : undefined,
	};
}
