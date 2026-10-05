export const ADD_KEYS_COPY = {
	pasteBefore: "Paste",
	assignment: "KEY=value",
	pasteAfter: "lines or a flat JSON object.",
	description: "Paste KEY=value lines or a flat JSON object.",
	placeholder: "OPENAI_API_KEY=sk-…\nGITHUB_TOKEN=ghp_…",
	into: "Into vault",
	choose: "Choose a vault…",
	create: "Create vault…",
	name: "Vault name…",
	invalid: "Fix import text",
	overwrite: "Overwrite existing keys",
	preview: "Preview",
	save: "Save",
	taken: "That vault already exists. Choose it from the list or use a different name.",
};
export function addKeysDetectedCopy(count: number, skipped: number) {
	return `${count} ${count === 1 ? "key" : "keys"} detected${skipped > 0 ? ` · ${skipped} skipped` : ""}`;
}
export function addKeysConflictCopy(count: number) {
	return `${count} key${count === 1 ? "" : "s"} already exist. By default, they are skipped.`;
}
