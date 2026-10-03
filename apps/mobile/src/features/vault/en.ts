export const vaultEn = {
	splitTitle: "Split by app prefix",
	splitDescription:
		"Keys named app/KEY can be copied into one new Vault per prefix, removing that prefix from each name. Edit destination slugs to resolve naming conflicts. Values stay server-side.",
	splitSlug: "Destination slug",
	splitRemove: "Delete confirmed copied originals for every attached Project",
	splitInvalid:
		"Select prefixes with distinct valid destination slugs, different from this Vault. Use lowercase letters, numbers and hyphens.",
	splitComplete: "Complete",
	splitIncomplete: "Incomplete or unconfirmed",
	splitInspect:
		"New Vaults are not linked to Projects automatically. Failed or interrupted operations may leave destinations behind. Inspect both source and destinations before trying again; existing Vaults are never reused automatically.",
	splitReset: "Close report and review remaining keys",
	supplyTitle: "Supply requested credentials",
	supplyPrivacy:
		"Paste a request link to securely fill its fields. No sign-in token is sent. Leaving this screen or backgrounding the app clears the link and all entered secrets.",
	supplyLink: "HTTPS request link",
	supplyLoad: "Inspect request",
	supplyReveal: "Show secret values / edit multiline values",
	supplyName: "Field name",
	supplyValue: "Secret value",
	supplyMultiline: "Multiline secret hidden",
	supplyAdd: "Add field",
	supplyRemove: "Remove added field",
	supplyImport: "Import dotenv assignments",
	supplyReview: "Check fields and review",
	supplySave: "Save credentials",
	supplyWarning:
		"Save all entered fields to this Vault? The following existing keys will be replaced:",
	supplyNoUpdates: "No existing keys will be replaced.",
	supplyDone: "Credentials saved securely. No secret values are included in the receipt.",
	supplyReceipt: "Share completion receipt",
	supplyReceiptText:
		"Credentials saved. Check this Vault request status before continuing; never put secret values in chat:",
	supplyUnavailable:
		"This request is unavailable or its fields changed. Ask its creator to check the status or send a new link.",
	supplyUncertain:
		"Save could not be confirmed. Ask the request creator to check its status before trying again. No retry was sent.",
	supplyInvalid:
		"Check the request link or fields. Supply every required field, use distinct valid names, and at most 32 nonempty values (65536 characters each).",
	supplyConflict:
		"Selected fields changed or are reserved. Remove added fields or ask for a new link; no secrets were sent.",
	supplyReset: "Clear and start again",
	requests: "Secret requests",
	requestsDescription:
		"Recent 100 requests. Pending requests refresh for two minutes while this screen is active; refresh manually to continue. The latest link can be shared again until you leave this screen or background the app. Links are never saved to device storage.",
	requestReshare: "Share latest request again",
	requestCreate: "Create and share request",
	requestShare: "Supply requested credentials",
	requestWarning:
		"Anyone with this link can supply credentials, replace requested existing keys and add keys to this section. Share only with the intended recipient. After leaving this screen or backgrounding the app, the link cannot be recovered here. Continue?",
	requestFields: "Key names only, separated by commas or new lines",
	requestInvalid:
		"Select an attached Project and enter 1–32 distinct valid key names. Do not paste secret values here.",
	requestPending: "Awaiting input",
	requestSupplied: "Supplied",
	requestConflict: "Credentials changed",
	requestExpired: "Expired",
	requestFiveMinutes: "Expires in 5 minutes",
	requestHour: "Expires in 1 hour",
	requestDay: "Expires in 24 hours",
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
	selectSection: "Select entire section",
	selectKey: "Select key",
	selectedCount: "Selected keys",
	clearSelection: "Clear selection",
	copySelected: "Copy selected keys",
	moveSelected: "Move selected keys",
	selectedCopyWarning:
		"Matching destination keys will be overwritten. Copies are independent: later changes do not sync. To share one source of truth, attach this Vault to another Project instead. Values remain server-side.",
	moveWarning:
		"Matching destination keys will be overwritten, then confirmed copied keys will be deleted from this Vault for EVERY attached Project. This is a non-atomic copy followed by delete; avoid editing these keys concurrently. Partial results are possible. Values remain server-side.",
	copiedCount: "Confirmed copies",
	copyUnconfirmed: "Copy incomplete or unconfirmed; check both Vaults before retrying",
	cleanupUnconfirmed: "Source deletion skipped or unconfirmed; check source keys",
	chooseTarget: "Choose a destination Vault",
	loadTargets: "Load more destinations",
	noKeys: "No keys in this Vault.",
	defaultSection: "Default section",
} as const;
