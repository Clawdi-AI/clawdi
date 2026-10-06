import { createHash } from "node:crypto";
import { AGENT_FILES } from "@/lib/agent-files";
import clawdiSkill from "../../../../packages/cli/skills/clawdi/SKILL.md?raw";
import { parseFrontmatter } from "../../../../packages/cli/src/lib/frontmatter";

export { clawdiSkill };

const { name, description } = parseFrontmatter(clawdiSkill).data;
if (
	!name ||
	name.length > 64 ||
	!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
	!description ||
	description.length > 1024
) {
	throw new Error("Bundled Clawdi skill metadata must satisfy discovery RFC v0.2.0");
}

export const agentSkillsIndex = {
	$schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
	skills: [
		{
			name,
			type: "skill-md",
			description,
			url: AGENT_FILES.skill.path,
			digest: `sha256:${createHash("sha256").update(clawdiSkill, "utf8").digest("hex")}`,
		},
	],
};
