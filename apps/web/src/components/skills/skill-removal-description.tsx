export function SkillRemovalDescription({ projectName }: { projectName?: string | null }) {
	return (
		<p>
			Every Agent using {projectName || "this Project"} loses this Skill. Other Projects keep their
			copies.
		</p>
	);
}
