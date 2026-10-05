export const memoryFormCopy = {
	title: "Create memory",
	description: "A note your AI recalls across all agents and machines.",
	content: "Memory content",
	placeholder: "Prefer concise PR summaries…",
	category: "Category",
	secrets: "Use Vault for secrets",
	cancel: "Cancel",
	save: "Save memory",
	deleteTitle: "Delete this memory?",
	deleteDescription: "Deleting removes this memory from all agents.",
	delete: "Delete memory",
	deleteDetailDescription:
		"All agents will stop recalling it within seconds.\nYou can tell it the same thing again later.",
	mem0Title: "Mem0 Configuration",
	mem0Description: "Enter your Mem0 API key to use semantic memory search.",
	mem0Label: "Mem0 API key",
	mem0Placeholder: "m0-…",
	mem0Save: "Save API Key",
} as const;

export const vaultFormCopy = {
	title: "Create vault",
	description: "A bundle of API keys your Agents can use. Add it to Projects to control access.",
	name: "Name",
	placeholder: "GitHub, OpenAI, Production…",
	nameTaken: "That vault already exists. Open it from the vault list or use a different name.",
	cancel: "Cancel",
} as const;

export const splitVaultCopy = {
	description:
		"Keys named app/KEY become a vault per app, renamed to their clean KEY. Values stay server-side. New Vaults are not automatically linked to Projects. Copy and deletion are non-atomic; avoid concurrent edits. Failed destinations may remain; inspect them before retrying.",
	invalid:
		"Choose distinct destination slugs using lowercase letters, numbers and hyphens, different from the source Vault.",
	inspect:
		"Inspect created Vaults before starting another split. Existing Vaults are never reused automatically.",
};
export function splitVaultTitle(name: string) {
	return `Split ${name} by app prefix`;
}
export function splitVaultSubmit(keys: number, groups: number) {
	return `Split ${keys} keys into ${groups} ${groups === 1 ? "vault" : "vaults"}`;
}
export function splitVaultRemoveLabel(name: string) {
	return `Remove the originals from ${name} (move)`;
}

export const vaultKeyFormCopy = {
	addTitle: "Add keys",
	save: "Save",
	addDescriptionBefore: "Paste ",
	format: "KEY=value",
	addDescriptionAfter: " lines or a flat JSON object.",
	placeholder: "OPENAI_API_KEY=sk-…\nGITHUB_TOKEN=ghp_…",
	overwrite: "Overwrite existing keys",
	preview: "Preview",
	invalid: "Fix import text",
	destination: "Destination vault",
	deleteVaultDescription:
		"Every key in this vault is removed for every Project using it. Agents lose access immediately.",
	deleteVault: "Delete vault",
	deleteKeyDescription: "The key is removed for every Project using this vault.",
	deleteKey: "Delete key",
	chooseVault: "Choose a vault…",
	copyDescription:
		"Each key becomes an independent copy — changing a value later updates only one vault, not both.",
	moveDescription:
		"Values stay server-side. Move is a non-atomic copy followed by deletion; partial results are possible. Avoid editing these keys concurrently.",
	referenceBefore: "Just want these keys available in another Project? Use ",
	referenceAction: "Link vault",
	referenceAfter: " on this vault instead — one source of truth, changes apply everywhere.",
};
