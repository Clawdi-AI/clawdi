export function skillRemovalTitle(name: string) {
	return `Remove ${name} from project?`;
}
export function skillRemovalDescription(projectName?: string | null) {
	return `Every agent using ${projectName || "this project"} loses this skill. Other projects keep their copies.`;
}
