const agentExtensionsEn = {
	allCategories: "All categories",
	loadError: "Couldn't load plugins",
	pluginRemove: "Remove plugin",
	pluginRemoveWarning:
		"Remove this plugin and its Skills and MCP servers from the Agent? Runtime cleanup may finish later.",
	install: "Install",
	uninstallTitle: agentSkillUninstallCopy.title("{name}"),
	uninstallWarning: agentSkillUninstallCopy.description,
	uninstallConfirm: agentSkillUninstallCopy.confirm,
	accepted: "Change requested. It may take a moment to apply.",
	installed: agentSurfaceCopy.installed,
	installing: agentSkillInstallCopy.installing,
	installFailed: agentSkillInstallCopy.installFailed,
	guardBlockedTitle: agentSkillInstallCopy.guardBlockedTitle,
	guardBlocked: agentSkillInstallCopy.guardBlocked,
	guardBlockedGitHub: agentSkillInstallCopy.guardBlockedGitHub,
	guardConfirmationRequiredTitle: agentSkillInstallCopy.guardConfirmationRequiredTitle,
	guardConfirmationRequired: agentSkillInstallCopy.guardConfirmationRequired,
	updateFailedTitle: agentSkillInstallCopy.updateFailedTitle,
	updateFailed: agentSkillInstallCopy.updateFailed,
	removalFailed: "Couldn't remove this Skill. Check the agent, then refresh.",
	view: "View Library Skill",
};
const agentSettingsEn = {
	unsavedTitle: "Discard unsaved name?",
	unsavedMessage: "Your Agent name changes have not been saved.",
	discard: "Discard changes",
};
const billingEn = {
	unknown: "Unavailable",
	noStore: "Store purchases, top-ups, restore and refunds are not available in this build.",
} as const;
const channelsEn = {
	singular: "Channel",
	linkedAt: "Linked {time}",
	deleteAction: "Delete channel",
	configure: "Configure",
	name: "Bot name",
	token: "Bot token",
	applicationId: "Discord application ID",
	publicKey: "Discord interactions public key",
	createUncertain:
		"This bot may already have been created. Refresh and inspect inventory before submitting again. Closing this form does not undo a request already sent.",
	reviewInventory: "Refresh inventory before another submission",
	title: "Channels",
	failed:
		"The action was not confirmed. Refresh before trying again. Channel availability, capacity or runtime permissions may have changed.",
};
const whatsappEn = {
	repair: "Repair WhatsApp connection",
	leaving: "Switching apps pauses checking. Return here to continue.",
};
const connectorsEn = {
	title: "Connectors",
	oauth: "Authorize in the browser, then return here.",
} as const;
const storeEn = {
	checkPending: "Check pending purchases",
	checkingPending: "Checking pending purchases…",
	noPending: "No pending purchases found.",
	usdcInApp: "Browser-wallet USDC funding isn't available in this app.",
	walletExplanation: "Pays for AI usage and wallet-funded compute subscriptions.",
	walletSummary: "Balance and transactions",
	purchasing: "Confirming top-up…",
	unavailable: "Purchases aren't available right now. Your Wallet balance is unaffected.",
	// Web's top-up results; store-only states keep their meaning in the same wording.
	fundingApplied: `${walletTopupCopy.credited.title}. ${walletTopupCopy.credited.description}`,
	submitted: `${walletTopupCopy.accepted.title}. ${walletTopupCopy.accepted.description}`,
	processing: `${walletTopupCopy.processing.title}. ${walletTopupCopy.processing.description}`,
	paymentPending: "Top-up waiting for approval. We'll credit your wallet once it's approved.",
	unconfirmed:
		"Top-up not confirmed yet. If you were charged, we'll credit your wallet automatically, and trying again won't charge you twice.",
	purchaseInProgress: "Another top-up is still being confirmed. Try again after it completes.",
	reviewRequired:
		"This purchase needs billing review. Contact support; buying again won't resolve it.",
	notCompleted: `${walletTopupCopy.notFinished.title}. Your wallet wasn't credited.`,
	refundDebt: "Purchases are paused while a refunded purchase is unresolved. Contact support.",
	paywallUnavailable: "Top-up options couldn't be loaded. Try again later.",
	accountChanged: "Your account changed during the purchase. Check your Wallet after signing in.",
	failed: "The top-up couldn't be started. Try again.",
	creditsNotice: "Top-ups bought in this app are added to your Wallet and don't expire.",
	cardDunning:
		"Payment for this subscription needs attention. Card payments can't be updated in this app.",
	walletDunning:
		"Your Wallet balance is too low to renew this subscription. Top up; billing updates automatically after funding.",
} as const;
/** Compute subscriptions billed by the App Store or Google Play ({store}). */
const storeComputeEn = {
	subscribeTitle: "Subscribe with {store}",
	subscribeDescription: "Choose a plan next. {store} bills this Agent's compute.",
	subscribeDeploy: "Subscribe and deploy",
	upgrade: "Upgrade with {store}",
	upgradeDescription: "Move this Agent from Included Basic to a plan billed by {store}.",
	purchasing: "Confirming subscription…",
	waitingForApproval:
		"Waiting for approval. Your Agent is created only after the purchase is approved. Check its status here.",
	waitingForApprovalUpgrade:
		"Waiting for approval. This Agent upgrades after the purchase is approved.",
	waitingForApprovalChange:
		"Waiting for approval. The plan change applies after the purchase is approved.",
	processing:
		"Your subscription is still being confirmed. Refresh to see the latest status, or check again later.",
	submitted: "Subscription submitted. It applies automatically once {store} confirms it.",
	unconfirmed:
		"This purchase couldn't be confirmed yet. If you were charged, the subscription applies automatically, and trying again won't charge you twice.",
	notCompleted: "The purchase wasn't completed. You weren't subscribed.",
	upgraded: "Subscription active. This Agent now uses it.",
	changed: "Plan change confirmed. {store} applies it on its own schedule; details update here.",
	unavailable: "Subscriptions couldn't be loaded. Try again later.",
	failed: "The subscription couldn't be started. Try again.",
	alreadySubscribed: "You already have a {store} subscription for this. Check Billing.",
	planMismatch:
		"This saved Agent request uses {plan}. Choose a {plan} plan, or discard the saved request first.",
	changePlan: "Change plan",
	changePlanDescription: "Choose a new plan. {store} decides when the change takes effect.",
	autoRenew: "Renews automatically until cancelled in {store} settings.",
	termsOfUse: "Terms of Use (EULA)",
	privacyPolicy: "Privacy Policy",
	manage: "Manage subscription",
	restore: "Restore purchases",
	restoring: "Restoring purchases…",
	restored: "Purchases restored.",
	nothingToRestore: "No subscriptions to restore.",
	restorePending: "Your purchases are still being checked. Try again in a few minutes.",
	restoreFailed: "Purchases couldn't be restored. Try again.",
	checkStatus: "Check status",
	previousPurchasePreparing:
		"A previous purchase is still being prepared. You can try again after {time}.",
	previousPurchasePreparingSoon:
		"A previous purchase is still being prepared. Try again in about 15 minutes.",
	underReview: "We're reviewing this purchase. Contact support if it doesn't resolve.",
	checkingStatus: "Checking status…",
	stillWaiting: "The purchase isn't confirmed yet. Check again after it is approved.",
	fundingConfirmed: "Subscription confirmed. Deploy to create this Agent.",
	ownedByOtherAccount: "This {store} subscription is linked to a different Clawdi account.",
	slotTitle: "{store} subscription",
	slotBound: "Used by {agent}",
	slotAvailable: "Available for your next Agent",
	deletionContinue: "I've cancelled — continue",
} as const;
const creationEn = {
	storeRowUnavailable:
		"This {store} subscription isn't free for a new agent from this account right now. Check Compute for its status.",
	subscriptionUnavailable:
		"Subscription no longer available. Choose a current reusable subscription or start a new one.",
	walletQuoteChanged: "The wallet quote changed. Review the new amount, then confirm again.",
	walletNotFound: "We couldn't find this payment — you can try again.",
	blocked:
		"This compute choice isn't available for a new agent. Choose another subscription or plan.",
	recover: "Check status",
	retry: "Retry",
	clear: "Start over",
	discard: "Discard setup",
	notAdmitted:
		"This agent couldn't be created with the selected compute. Discard this setup to change your choices.",
	reservedTitle: "Finish setting up your agent",
	reservedDescription:
		"Your {store} subscription is reserved for an Agent that hasn't been created yet. Choose its settings, then finish setup.",
	reservedAction: "Finish setting up",
	reservedNotice:
		"This Agent uses your {store} subscription. Nothing new is purchased when you finish setup.",
	storeComputeUnavailable:
		"Your store subscription can't be used for this Agent. Check status, subscribe again, or discard this request.",
	storeComputeDisabled:
		"Deploying with a store subscription is temporarily unavailable. Your setup is saved. Check status, then retry later.",
	storeComputePending:
		"Your subscription is still being prepared for this agent. Check status, then retry in a moment.",
	saved: "This agent's setup is saved on this device. Check its status before retrying.",
	creating: "Creating your agent…",
	unconfirmed: "We couldn't confirm this attempt — check status before trying again.",
	wait: "Your agent is still being set up. Check again in a moment.",
	failed: "This setup didn't finish. Start over to try again.",
	error: "Something went wrong. Your setup is saved — check its status before retrying.",
	storageError:
		"We couldn't read your saved setup. Deploying is paused so nothing is created twice.",
} as const;
const runtimeEn = {
	stoppedLabel: "Stopped",
	deleteKeepChoice: "Keep subscription",
	deleteCancelChoice: "Cancel subscription",
	deleteCancelsSubscription: "This request also cancels the Agent's subscription.",
	deleteReported:
		"The server reports this Agent deleted for your account. Cleanup may still be in progress.",
	supportFailed: "Couldn't open your email app. Email support@clawdi.ai.",
	uncertain:
		"We couldn't confirm the last change. Retry it before making another — retrying won't apply it twice.",
	prepared: "Your change wasn't sent. Retry it or discard it.",
	storageError:
		"We couldn't read the last change saved on this device. Changes are paused until it loads.",
	reloadAttempt: "Reload",
	retry: "Retry last change",
	conflict: "This agent changed since you started. Refresh and review before trying again.",
	review: "Discard change",
	discardUncertainTitle: "Discard unconfirmed change?",
	discardUncertainWarning:
		"We couldn't confirm whether this change was applied. Discarding only removes it from this device. Check the agent's status before making another change.",
	failed: "We couldn't confirm this change. Refresh and try again.",
	modelId: "Model ID",
	modelsInAgent:
		"This connection's models are configured inside the Agent. Applying it will not overwrite its model catalog.",
	unmanagedWarning:
		"This removes Clawdi's provider binding and keeps the Agent's own settings. It does not revoke the saved provider account.",
	providerConflict:
		"The Agent reported a provider configuration conflict. Its own settings may take precedence. Review the binding before changing it.",
};
const deploymentsEn = {
	unavailable: "Cloud deployment access is not configured.",
} as const;
const workspaceSkillsEn = {
	commandDescription: agentSurfaceCopy.enterAGitHubSkillPathThenRunTheGeneratedCommand,
	syncedDescription: agentSurfaceCopy.skillsAvailableInThisAgentSWorkspace,
	search: "Search Skills…",
	updateError: "Couldn't update Skill",
	noMatches: "No Skills found",
	uninstallAction: "Uninstall",
	inventoryDescription: "Skills available in this Agent's Workspace.",
	loadError: "Couldn't load Skills",
	inventoryEmpty: "No Skills have synced from this Agent yet.",
	source: "GitHub owner/repo or owner/repo/path",
	install: "Install",
	unavailable: "Changes are unavailable until this agent finishes loading. Refresh to try again.",
	accepted: "Change requested. It may take a moment to apply.",
	open: "Read Skill",
	uncertain: "We couldn't confirm the last change. Retry it before making another.",
	notApplied: "This change wasn't applied. Retry it or discard it.",
	conflict:
		"This agent's Skills changed since this change was saved. Review them and try again if needed.",
	retry: "Retry last change",
	discard: "Discard change",
	discardWarning: "Discard this change and reload this agent's Skills?",
	discardUncertainWarning:
		"We couldn't confirm whether this change was applied. Discarding only removes it from this device. Check the Skills list before trying again.",
	storageError: "We couldn't read the last change saved on this device. Reload to continue.",
	reload: "Reload",
	error: "We couldn't confirm this change. Refresh and try again.",
};
const vaultEn = {
	singular: "Vault",
	from: "from",
	to: "to",
	linkedToProjects: "Linked to projects",
	allVaults: "All vaults",
	destinationsError: LIBRARY_COPY.loadDestinationsFailed,
	existingKeysError: LIBRARY_COPY.checkExistingKeysFailed,
	catalogError: LIBRARY_COPY.loadVaultCatalogFailed,
	splitTitle: "Split by app prefix",
	splitSlug: "Destination slug",
	splitComplete: "Complete",
	splitIncomplete: "Incomplete or unconfirmed",
	splitInspect:
		"New Vaults are not linked to Projects automatically. Failed or interrupted operations may leave destinations behind. Inspect both source and destinations before trying again; existing Vaults are never reused automatically.",
	splitReset: "Close report and review remaining keys",
	/** The native share sheet stands in for Web's clipboard copy. */
	shareMessage: "Share message for agent",
	open: "Open Vault",
	keys: "Keys",
	section: "Section (empty for default)",
	importText: "Paste dotenv or flat JSON",
	import: "Import keys",
	importWarning:
		"This writes secrets to the selected Vault and affects every Project using it. Existing keys are skipped unless you enable replacement. Continue?",
	invalidImport:
		"Invalid import. Check key names, duplicates, and quoting. Nothing will be imported.",
	clear: "Clear pasted secrets",
	saved: "Changes saved.",
	deleteKey: "Delete key",
	deleteTitle: "Delete {name}?",
	detach: "Detach Project",
	attach: "Attach to Project",
	attachTarget: "Choose a project",
	attachWarning:
		"Give this Project and its Agents access to this Vault? Existing secrets remain in the selected Vault.",
	detachWarning:
		"Remove this Project's access to the Vault? Its Agents may no longer receive these secrets. The Vault and keys remain.",
	selectedCopyWarning:
		"Matching destination keys will be overwritten. Copies are independent: later changes do not sync. To share one source of truth, attach this Vault to another Project instead. Values remain server-side.",
	moveWarning:
		"Matching destination keys will be overwritten, then confirmed copied keys will be deleted from this Vault for EVERY attached Project. This is a non-atomic copy followed by delete; avoid editing these keys concurrently. Partial results are possible. Values remain server-side.",
	copiedCount: "Confirmed copies",
	copyUnconfirmed: "Copy incomplete or unconfirmed; check both Vaults before retrying",
	cleanupUnconfirmed: "Source deletion skipped or unconfirmed; check source keys",
	loadTargets: "Load more destinations",
} as const;

import {
	accountDeletionCopy,
	agentSkillInstallCopy,
	agentSkillUninstallCopy,
	agentSurfaceCopy,
	billingCopy,
	DASHBOARD_COPY,
	LIBRARY_COPY,
	SESSION_LIST_COPY,
	sessionDetailCopy,
	settingsCopy,
	usageCopy,
	walletTopupCopy,
} from "@clawdi/shared/view";
export const en = {
	labels: {
		free: "Free",
		sharedTime: "Shared {time}",
		usedBy: "used by {names}{remaining}",
		openVault: "Open vault {name}",
		inContext: "In this {context}",
		vaultLinksError: "Couldn't load {context} vault links",
		removeFrom: "Remove {name} from {context}?",
		hide: "Hide",
		show: "Show",
		sessionsOnDate: "{sessions} on {date}",
		projectOwner: "by {name}",
		uninstallSkill: "Uninstall {name} from agent",
		openAgent: "Open {name}{status}",
		agentStatus: ". Status: {status}",
		openSession: "Open session {title}",
		message: "message",
		messages: "messages",
		shareProject: "Share {name}",
		shareDetails: "{scope} · {count} {unit} · Created {time}",
		openMemory: "Open memory: {name}",
		deleteMemory: "Delete memory: {name}",
		openItem: "Open {name}",
		actionsFor: "Actions for {name}",
		connected: "Connected",
		connectorAccount: "Account {id}",
		pairChannel: "Pair {provider}",
		pairingCode: "{provider} pairing QR code",
		learnedOn: "Learned on {machine}",
		editProvider: "Edit {name}",
		setupProvider: "Set up {name}",
		editable: "Editable",
		readOnly: "Read-only",
	},
	sessionDetailMobile: {
		currentSearchMatch: "Current search match",
		liveLink: "Live session link",
		more: "more",
	},
	settingsParity: settingsCopy,
	billingParity: billingCopy,
	usageParity: usageCopy,
	accountDeletion: accountDeletionCopy,
	sessionDetail: sessionDetailCopy,
	libraryPort: LIBRARY_COPY,
	composite: {
		remove: "Remove",
		save: "Save",
		add: "Add",
		open: "Open",
		confirm: "Confirm",
		cancel: "Cancel",
		codeText: "text",
	},
	profile: {
		unsavedTitle: "Discard profile changes?",
		discard: "Discard changes",
	},
	appearance: {
		failed: "Could not read or save your appearance preference. Please retry.",
		retry: "Retry loading appearance",
	},
	support: {
		failed: "Couldn’t open live chat",
	},
	settingsMenu: {
		unavailable: "Settings unavailable",
		privacyPolicy: "Privacy Policy",
		termsOfUse: "Terms of Use",
		linkFailed: "Couldn't open this link. Try again.",
	},
	publicSession: {
		title: "Shared Session",
		changed: "The conversation changed while loading. Refresh to start again.",
	},
	markdown: {
		previewImage: "Preview image",
		imagePrivacy:
			"Download this external image without account credentials? The image host will receive your network request. Only PNG, JPEG and WebP up to 4 MiB are supported.",
		imageLoading: "Loading image…",
		imageFailed:
			"Could not preview this image. It may be unavailable, too large or unsupported. Close it to retry or open the original link.",
		closeImage: "Close image",
		openLink: "Open external link",
		openFailed: "Could not open this link. Try again when this screen is active.",
		image: "Image",
		plainFallback:
			"This content is shown as plain text to keep large or complex messages responsive.",
	},
	agentExtensions: agentExtensionsEn,
	workspaceSkills: workspaceSkillsEn,
	agentSettings: agentSettingsEn,
	runtime: runtimeEn,
	channels: channelsEn,
	whatsapp: whatsappEn,
	providers: {
		ready: "Ready",
		setupRequired: "Setup required",
		removalUnavailable: "Provider removal requires a configured Hosted API.",
		connectOAuth: "Connect ChatGPT",
		reconnectOAuth: "Reconnect ChatGPT",
		stopOAuth: "Stop waiting",
		oauthOffline: "Offline. Checking will resume when connectivity returns.",
		oauthReady: "Connection authorized.",
		failed:
			"Could not complete the action. Refresh to check the current state before trying again.",
	},
	vault: vaultEn,
	connectors: connectorsEn,
	billing: billingEn,
	creation: creationEn,
	/** Choose a paid subscription for an existing Agent: its saved Wallet request. */
	subscriptionSheet: {
		saved:
			"This subscription request is saved on this device. Review the new quote and confirm again, or discard it.",
		unconfirmed:
			"We couldn't confirm this payment — check status before trying again. Checking won't charge you twice.",
		discard: "Discard request",
	},
	store: storeEn,
	storeCompute: storeComputeEn,
	deployments: deploymentsEn,
	navigation: {
		backTo: "Back to",
		home: "Overview",
		agents: "Agents",
		sessions: "Sessions",
		library: "Library",
		vaults: "Vaults",
		back: "Back",
	},
	loading: {
		app: "Loading Clawdi",
		authentication: "Checking your account",
	},
	configuration: {
		title: "Clawdi needs configuration",
		message: "Ask your administrator to provide the mobile API and authentication configuration.",
		missing: "Required configuration is missing.",
		invalid: "The mobile configuration is invalid.",
	},
	auth: {
		devBypassUnavailable: "Account management unavailable",
		devBypassDescription:
			"Sign in with your Clerk account to manage your profile and security settings.",
	},
	home: {
		automatedSessions: DASHBOARD_COPY.automatedSessions,
		statsSkills: "Skills",
	},
	inventory: {
		loadMore: "Load more",
		notFound: "This item is unavailable or no longer exists.",
		viewAll: "View all",
		viewDetails: "Details",
	},
	agents: {
		unavailable: "Agent unavailable",
		runCommands: "Run commands",
		desktopHint:
			"On your computer, Clawdi Desktop finds your agents, connects them, and turns on sync.",
		askAgent: "Ask your agent",
		waitingForConnection: agentSurfaceCopy.waitingForYourAgentToConnect,
		loadError: "Couldn't load Agent",
		sectionUnavailable: "Agent section unavailable",
		title: "Cloud Agents",
	},
	sessionFilters: {
		search: "Search Sessions and messages…",
		options: "Filters and sorting",
		agent: "Agent type",
		all: "All",
		allProfiles: "All profiles",
		type: "Session type",
		manual: "Manual",
		automated: SESSION_LIST_COPY.automated,
		pr: "Pull request links",
		hasPr: "Has PR links",
		noPr: "No PR links",
		sort: "Sort by",
		last_activity_at: "Last activity",
		started_at: "Started",
		message_count: "Message count",
		tokens: "Tokens",
		updated_at: "Updated",
		relevance: "Relevance",
		order: "Order",
		asc: "Ascending",
		desc: "Descending",
		pageSize: "Results per page",
		apply: "Apply search and filters",
		reset: "Reset search and filters",
		total: "Matching Sessions",
		empty: "No Sessions match the current search and filters.",
	},
	timeline: {
		tokensSeparator: "tokens ·",
		earlier: "Load earlier activity",
		later: "Load later activity",
		moreText: "Show more text",
	},
	sessions: {
		noMessages: "No message transcript is available yet.",
		revisionChanged: "The transcript changed. Refresh to load its current version.",
	},
	skills: {
		singular: "Skill",
		projectContext: "Project Skill · in",
		addedSeparator: "· added",
		chooseProject:
			"This Library link is read-only. Open the Skill from its Project to edit or manage that exact copy.",
		saved: "Skill saved. You can return to the Skills list.",
		project: "Project",
		discard: "Discard draft and reload",
		discardWarning: "Your unsaved changes will be lost.",
		readOnly:
			"Only owned cloud Projects can be edited. Agent-synced and shared Skills are read-only.",
		noContent: "No text content is available.",
		conflict:
			"This Skill changed while you were editing. Your draft is preserved. Copy your changes before discarding and reloading.",
		failed: "The change could not be confirmed. Check the current Skill before retrying.",
		title: "Skills",
	},
	memories: {
		learnedFromSession: LIBRARY_COPY.learnedFromSession,
		savedSeparator: "· Saved",
		tags: "Tags:",
		viewSession: "View session",
		edit: "Edit memory",
		builtin: "Built-in",
		title: "Memories",
	},
	bindings: {
		unlink: "Unlink project",
		unlinkWarning:
			"Remove this project's context and key access from this Agent? The project itself will not be deleted.",
	},
	projects: {
		unavailable: "Project unavailable",
		actions: "Project actions",
		moveUp: "Move up",
		moveDown: "Move down",
		agentProjectsDescription: LIBRARY_COPY.agentProjectsDescription,
		loadError: LIBRARY_COPY.loadProjectsFailed,
		linkError: LIBRARY_COPY.updateProjectLinkFailed,
		viewer: "Viewer",
		open: "Open project",
		filter: "Project scope",
		agentsScope: "Your Agents linked to this Project. Other members' Agents are not listed.",
		all: "All projects",
		choose: "Choose a project",
		sharing: "Manage sharing",
		create: "New project",
		edit: "Edit project",
		name: "Project name",
		archive: "Archive project",
		archiveWarning:
			"Archive this project and unlink its Agents? Shared members will also lose access.",
		title: "Projects",
		description: "Projects available to your account.",
		empty: "No projects are available for this account.",
		owner: "Owner",
		shared: "Shared",
	},
	sharing: {
		vaults: "Vaults",
		unavailable: "Only the owner of an active user-created project can manage sharing.",
		email: "Existing account email",
		label: "Link label (optional)",
		shareLink: "Share invite link",
		once: "This link grants access to the project. It is shown once and hidden when you leave this screen or background the app.",
		dismiss: "Hide link",
		failed:
			"The change could not be confirmed. Refresh before retrying. Invitations require an existing account and sharing requires a profile display name.",
		active: "Active",
		inactive: "Expired or revoked",
		redemptions: "redemptions",
		revoke: "Revoke link",
		cancelInvite: "Cancel invitation",
	},
	account: {
		apiKey: "API key",
		cancel: "Cancel",
	},
} as const;
export type TranslationKey = {
	[Scope in keyof typeof en]: `${Scope}.${keyof (typeof en)[Scope] & string}`;
}[keyof typeof en];
