import type { components } from "./api.generated";

export type SkillTextDraft = components["schemas"]["SkillCreateRequest"];

export function requireSkillContentHash(hash: string): string {
	if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Reload this Skill before changing it");
	return hash;
}

export function stripFrontmatter(raw: string): string {
	const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
	return m ? (m[1] ?? "") : raw;
}

export function buildSkillCreateRequest(draft: SkillTextDraft): SkillTextDraft {
	return {
		name: draft.name,
		description: draft.description,
		instructions: draft.instructions.trim(),
	};
}

export function buildSkillUpdateRequest(
	draft: SkillTextDraft,
	editingHash: string,
): components["schemas"]["SkillContentUpdateRequest"] {
	return { ...buildSkillCreateRequest(draft), content_hash: requireSkillContentHash(editingHash) };
}

/** Project install schema is stricter than Hosted runtime installation. */
export function parseProjectSkillGitHubInput(
	input: string,
): components["schemas"]["SkillInstallRequest"] {
	let clean = input.trim();
	// Reject normalization ambiguities before URL parsing can erase dot segments.
	if (
		clean.includes("\\") ||
		clean.includes("%") ||
		clean.split("/").some((part) => part === "." || part === "..")
	)
		throw new Error("Invalid Skill repository path");
	if (clean.includes("://")) {
		const url = new URL(clean);
		if (
			url.protocol !== "https:" ||
			url.host !== "github.com" ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		)
			throw new Error("Enter a canonical GitHub repository URL");
		clean = url.pathname.slice(1);
	}
	clean = clean.replace(/\/$/, "");
	const [owner, repo, ...parts] = clean.split("/");
	if (
		!owner ||
		!repo ||
		!/^[A-Za-z0-9._-]{1,100}$/.test(owner) ||
		!/^[A-Za-z0-9._-]{1,100}$/.test(repo)
	)
		throw new Error("Enter owner/repository or a GitHub skill path");
	const path = parts.join("/");
	if (
		path.length > 200 ||
		parts.some((part) => !part || part === ".." || !/^[A-Za-z0-9._-]+$/.test(part))
	)
		throw new Error("Invalid Skill repository path");
	return { repo: `${owner}/${repo}`, path: path || undefined };
}
