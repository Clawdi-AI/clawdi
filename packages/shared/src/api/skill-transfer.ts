import type { components } from "./api.generated";
import { ApiClientError } from "./read-transport";
import { validateSkillUploadReceipt } from "./skill-client";
import { requireSkillContentHash } from "./skill-content";
import { skillCapabilities } from "./skill-policy";

type Project = components["schemas"]["ProjectResponse"];
type Skill = Pick<
	components["schemas"]["SkillSummaryResponse"],
	"project_id" | "project_kind" | "authority" | "skill_key" | "content_hash"
>;

export function skillTransferTargets(projects: Project[], sourceId: string) {
	return projects.filter(
		(p) => p.id !== sourceId && p.kind === "workspace" && p.is_owner !== false && !p.archived_at,
	);
}

/** A move only attempts the revision-guarded delete after confirmed upload.
 * Failed deletion is a partial copy, never an automatic retry or rollback. */
export async function transferSkill(input: {
	skill: Skill;
	source: Project;
	target: Project;
	move: boolean;
	download: () => Promise<Blob>;
	upload: (archive: Blob) => Promise<components["schemas"]["SkillUploadResponse"]>;
	remove: (contentHash: string) => Promise<unknown>;
}) {
	const { skill, source, target } = input;
	if (
		skill.project_id !== source.id ||
		source.archived_at ||
		!skillCapabilities(skill, source).canSend ||
		!skillTransferTargets([target], source.id).length
	)
		throw new ApiClientError(403, "skill_transfer_not_allowed");
	const revision = requireSkillContentHash(skill.content_hash);
	const archive = await input.download();
	const receipt = await input.upload(archive);
	validateSkillUploadReceipt(receipt, skill.skill_key);
	if (!input.move) return { sourceRemoved: null };
	// The source may change between metadata and archive reads. Never remove
	// the selected revision unless the destination confirms those same contents.
	if (receipt.content_hash !== revision) return { sourceRemoved: false };
	try {
		await input.remove(revision);
		return { sourceRemoved: true };
	} catch {
		return { sourceRemoved: false };
	}
}
