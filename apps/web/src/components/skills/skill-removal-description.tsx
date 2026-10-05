import { skillRemovalDescription } from "@clawdi/shared/view";
export function SkillRemovalDescription({ projectName }: { projectName?: string | null }) {
	return <p>{skillRemovalDescription(projectName)}</p>;
}
