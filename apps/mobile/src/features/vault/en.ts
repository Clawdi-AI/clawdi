export const vaultEn = {
	title: "Vault",
	description:
		"Manage encrypted secrets. Only key names are returned; stored values are never revealed here.",
	empty: "No Vaults found.",
	search: "Search Vaults",
	searchAction: "Search",
	name: "Vault name",
	slug: "Vault slug",
	create: "Create Vault",
	open: "Open Vault",
	refresh: "Refresh",
	owner: "Owned by you",
	shared: "Shared · read only",
	keys: "Keys",
	section: "Section (empty for default)",
	importText: "Paste dotenv or flat JSON",
	import: "Import keys",
	importWarning:
		"This writes secrets to the selected Vault and affects every Project using it. Existing keys are skipped unless you enable replacement. Continue?",
	replace: "Replace existing keys",
	invalidImport:
		"Invalid import. Check key names, duplicates, and quoting. Nothing will be imported.",
	preview: "Import preview (names only)",
	createKey: "Create",
	updateKey: "Replace",
	skipKey: "Skip",
	clear: "Clear pasted secrets",
	failed: "The operation could not be confirmed. Refresh before trying again.",
	saved: "Operation completed.",
	remove: "Delete Vault",
	removeWarning:
		"Permanently delete this Vault and all of its secrets for every attached Project? This cannot be undone.",
	deleteKey: "Delete key",
	deleteWarning:
		"Permanently delete this key for EVERY Project using this Vault? This cannot be undone.",
	projects: "Attached Projects",
	detach: "Detach Project",
	attach: "Attach to Project",
	attachTarget: "Choose a Project",
	attachWarning:
		"Give this Project and its Agents access to this Vault? Existing secrets remain in the selected Vault.",
	detachWarning:
		"Remove this Project's access to the Vault? Its Agents may no longer receive these secrets. The Vault and keys remain.",
	unattached: "Not attached to any Project.",
	copyTarget: "Copy destination",
	copy: "Copy section to another Vault",
	copyWarning:
		"Copy every key in this section to the selected Vault? Matching destination keys will be overwritten. Values remain server-side.",
	chooseTarget: "Choose a destination Vault",
	loadTargets: "Load more destinations",
	noKeys: "No keys in this Vault.",
	defaultSection: "Default section",
} as const;
