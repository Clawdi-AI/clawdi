export function SkillRemovalDescription({ projectName }: { projectName?: string | null }) {
	return (
		<p>
			Every agent using {projectName || "this project"} loses this skill. Other projects keep their
			copies.
		</p>
	);
}
