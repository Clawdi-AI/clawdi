const agentExtensionsEn = {
	pluginRemove: "Remove plugin",
	pluginRemoveWarning:
		"Remove this plugin and its Skills and MCP servers from the Agent? Runtime cleanup may finish later.",
	install: "Install",
	remove: "Remove Library reference",
	removeWarning:
		"Remove this reference from the Agent? The original Library Skill is preserved. Runtime cleanup may finish later.",
	accepted:
		"Desired-state request accepted. Refresh to check runtime observation. Removal can remain pending after disappearing from this list.",
	failed:
		"The outcome was not confirmed. Refresh before explicitly trying again; a network error does not mean the request was rejected.",
	installed: "Observed installed",
	not_observed: "Not yet observed",
	failedState: "Runtime reported a failure",
	removalFailed: "The runtime reported a Skill removal failure. Refresh after checking the Agent.",
	view: "View Library Skill",
};
const agentSettingsEn = {
	name: "Agent display name",
	unsavedTitle: "Discard unsaved name?",
	unsavedMessage: "Your Agent name changes have not been saved.",
	discard: "Discard changes",
	uploadAvatar: "Choose avatar file",
	clearAvatar: "Restore default avatar",
	failed:
		"The change was not confirmed. Refresh before making another change: an earlier request may already have succeeded. Check permissions and the file format/size if uploading an avatar.",
};
const billingEn = {
	updating: "Updating subscription",
	processing: "Your request is still processing",
	unpaid: "Unpaid",
	actionRequired: "Payment action required",
	pastDue: "Past due",
	paymentProcessing: "Payment processing",
	attention: "Needs attention",
	awaitingPayment: "Waiting for payment confirmation",
	support: "Contact support to restore this subscription",
	ended: "Ended",
	paymentAttention: "Payment needs attention",
	retries: "Next payment retry",
	cancellation: "Cancellation is scheduled for the end of the current period.",
	pendingPlan: "Pending compute plan",
	providerRecovery:
		"Resolve billing through the purchasing provider. This app cannot initiate payment recovery yet.",
	unavailable: "The v2 compute API is not configured.",
	unknown: "Unavailable",
	details: "Subscription details",
	status: "Status",
	plan: "Compute plan",
	price: "Price per billing term",
	term: "Billing term (months)",
	periodEnd: "Current period ends",
	source: "Funding source",
	stripe: "Stripe",
	wallet: "Wallet",
	included: "Included Basic",
	agent: "Agent",
	deployment: "View deployment",
	management:
		"Manage this subscription through its purchasing provider. Native billing management and purchases are not connected yet.",
	walletNotice:
		"Wallet-funded compute currently uses Stripe invoice orchestration. It is not a store subscription.",
	noStore: "Store purchases, top-ups, restore and refunds are not available in this build.",
	moreToSearch:
		"This subscription was not on the loaded pages. Load more before concluding it is unavailable.",
} as const;
const channelsEn = {
	create: "Add Custom bot",
	name: "Bot name",
	token: "Bot token",
	applicationId: "Discord application ID",
	publicKey: "Discord interactions public key",
	createInstructions:
		"Use a Telegram token from BotFather, or Discord bot credentials from the developer portal. The bot is added without an Agent; linking and pairing are separate actions.",
	createUncertain:
		"This bot may already have been created. Refresh and inspect inventory before submitting again. Closing this form does not undo a request already sent.",
	reviewInventory: "Refresh inventory before another submission",
	title: "Channels",
	description: "Manage Custom bots, shared bots, Agent links and paired chats.",
	empty: "No channels available.",
	details: "Manage channel",
	shared: "Shared bot",
	custom: "Custom bot",
	links: "Linked agents",
	link: "Link selected Agent",
	replace: "Replace this Agent's existing channel for this provider",
	replaceWarning:
		"Replacement disconnects the previous bot for this provider. Paired chats may lose access.",
	selectAgent: "Select an Agent",
	unlink: "Unlink agent",
	pair: "Generate chat pairing code",
	pairInstructions:
		"Use this command in the intended chat. Codes expire after five minutes. Refresh paired chats to confirm; opening a link is not proof of pairing.",
	pairExpired: "Pairing code expired. Generate a new code.",
	openPair: "Open pairing link",
	install: "Install Discord bot",
	installUser: "Install Discord app for user",
	bindings: "Paired chats",
	noBindings: "No paired chats.",
	unpair: "Unpair chat",
	unpairWarning: "This chat will no longer be connected to the Agent.",
	cleanupWarning:
		"Chat access was revoked, but notification or provider cleanup is incomplete. Refresh to inspect the result.",
	unpairNotConfirmed: "Unpairing was not confirmed. Refresh paired chats before trying again.",
	activity: "Recent activity (up to 50 events)",
	remove: "Delete Custom bot",
	removeWarning: "Deleting this bot disconnects its Agents and chats. This cannot be undone.",
	sync: "Sync channel commands",
	done: "Action confirmed. Refresh to inspect current state.",
	failed:
		"The action was not confirmed. Refresh before trying again. Channel availability, capacity or runtime permissions may have changed.",
	unavailable:
		"Channel permissions or availability could not be confirmed. Refresh before making changes.",
	refresh: "Refresh channels",
	health: "Channel health",
	ok: "Healthy",
	warning: "Needs attention",
	error: "Unhealthy",
	unknown: "Health unavailable",
};
const whatsappEn = {
	repair: "Repair WhatsApp connection",
	warning:
		"Use a dedicated WhatsApp number you own. When linked to an Agent, replies are sent from this account. Agent linking and chat pairing remain separate steps.",
	repairWarning:
		"Repair replaces an invalid linked-device login. The Custom bot, Agent links, paired chats and history stay unchanged. Only repair an account you own.",
	leaving:
		"Switching apps hides pairing secrets and pauses checking. Return to this screen to resume. Leaving this screen does not cancel an already sent request; use Cancel connection to stop it explicitly. Unfinished sessions expire on the server.",
	approve: "I own this WhatsApp account and approve linking this device.",
	start: "Generate linked-device QR",
	retryStart: "Recover previous start request",
	uncertain:
		"The previous request may have started. Recovery reuses its original identity; it does not create a fresh request.",
	unavailable:
		"Linked-device availability or account ownership is not confirmed. Refresh to check.",
	offline: "Offline. Checking pauses until connectivity returns.",
	ready: "Ready to link WhatsApp",
	expired: "Connection expired. Check status, then retry to generate a fresh code.",
	qrLabel: "WhatsApp linked-device QR code",
	qrWaiting: "Waiting for a current QR code. Check connection status if this persists.",
	codeInstructions:
		"In WhatsApp → Linked devices → Link a device, choose Link with phone number instead and enter this code. Return here to confirm completion.",
	phone: "Country code and phone number (digits only)",
	check: "Check connection status",
	retry: "Retry this session",
	cancel: "Cancel connection",
	review: "Review custom bots",
	failed:
		"Connection status or the last action was not confirmed. Check status before retrying. Sensitive details are not included in this error.",
};
const connectorsEn = {
	title: "Connectors",
	catalog: "Browse apps",
	noAccounts: "No accounts connected to this app.",
	connect: "Connect account",
	disconnect: "Disconnect account",
	ready: "This app needs no credentials and is ready to use.",
	unavailable:
		"This authentication method is unavailable. Additional server configuration may be required.",
	oauth:
		"Authorize in the system browser, then close it and return here. Refresh accounts to check the result; opening or closing the browser does not mean authorization succeeded.",
	tools: "Available tools",
} as const;
const storeEn = {
	addCredits: "Add credits",
	checkPending: "Check pending purchases",
	checkingPending: "Checking pending purchases…",
	noPending: "No pending purchases found.",
	lowBalance: "Low — add credits before Clawdi AI pauses",
	recoveryStatus: "This subscription needs attention. Its status updates here automatically.",
	usdcInApp: "Browser-wallet USDC funding isn't available in this app.",
	walletExplanation: "Pays for AI usage and credit-funded compute subscriptions.",
	usageSummary: "LLM spend in credits, paid from wallet",
	purchasing: "Confirming purchase…",
	credits: "credits",
	unavailable: "Purchases aren't available right now. Your credits balance is unaffected.",
	fundingApplied: "Credits were added to your Wallet.",
	submitted: "Purchase submitted; credits will arrive in your Wallet.",
	processing:
		"Your purchase is still being confirmed. Credits are added automatically when it completes.",
	paymentPending:
		"Your purchase is waiting for approval. Credits are added automatically after it is approved.",
	unconfirmed:
		"This purchase couldn't be confirmed yet. If you were charged, credits are added automatically, and trying again won't charge you twice.",
	purchaseInProgress: "Another purchase is still being confirmed. Try again after it completes.",
	reviewRequired:
		"This purchase needs billing review. Contact support; buying again won't resolve it.",
	notCompleted: "The purchase wasn't completed. No credits were added.",
	refundDebt: "Credits can't be added while a refunded purchase is unresolved. Contact support.",
	paywallUnavailable: "Credit packs couldn't be loaded. Try again later.",
	accountChanged: "Your account changed during the purchase. Check your Wallet after signing in.",
	failed: "The purchase couldn't be started. Try again.",
	creditsNotice: "Credits bought in this app are added to your Wallet and don't expire.",
	cardBillingStatus: "Card billing for this subscription can't be managed in this app.",
	cardDunning:
		"Payment for this subscription needs attention. Card payments can't be updated in this app.",
	walletDunning:
		"Your Wallet balance is too low to renew this subscription. Add credits; billing updates automatically after funding.",
	walletNotice: "This subscription is paid with Wallet credits.",
	cardSource: "Card",
	dueNow: "Nothing due now",
	quoteBalance: "Wallet balance after payment",
	shortfall:
		"Add {amount} to cover this plan. The price preview refreshes after your credits arrive.",
} as const;
const creationEn = {
	savedProviderBoundary:
		"This saved provider can be previewed here. Mobile creation currently supports Clawdi AI or configuration inside the agent; select either before deploying.",
	unavailable: "Cloud creation is not configured.",
	language: "Language",
	selectionNotice:
		"Choose the compute plan for this Agent. The server selects a matching unbound entitlement; this does not select or purchase a specific subscription.",
	reusable: "Existing reusable subscriptions",
	quote: "Request price preview",
	quoteNotice:
		"A preview may initialize your billing profile. It does not pay an invoice or debit your wallet.",
	preview: "Invoice preview, not a payment",
	confirm:
		"I confirm the server may assign an existing entitlement for the selected plan, including an already-paid unbound subscription. This action does not purchase new compute.",
	blocked:
		"Creation requires the selected plan in the catalog and matching reusable inventory (or an available included Basic slot). Load more subscriptions if needed. The server verifies permission when you submit.",
	invalidRuntime: "Choose a supported runtime.",
	invalidCompute: "Choose an available compute plan.",
	invalidName: "Enter an Agent name with 1–64 characters.",
	invalidLanguage: "Choose a supported language.",
	invalidTimezone: "Use a valid IANA timezone or leave it empty.",
	invalidModel: "Choose a model from the current managed catalog.",
	recover: "Check saved creation request",
	retry: "Retry the same saved request",
	clear: "Finish recovery and start a new draft",
	discard: "Discard this unsubmitted or rejected draft",
	notAdmitted:
		"The server rejected this request before admission. You may explicitly discard it and edit a new draft.",
	saved:
		"A saved request exists. Check its status before retrying. No request is replayed automatically.",
	wait: "The server has not projected a deployment yet. Check again later.",
	failed:
		"The saved creation request is terminal. Review its status before starting another request.",
	error:
		"The action could not be completed. Your saved request is preserved; check its status before retrying.",
	storageError:
		"Saved creation data is unavailable or invalid. Creation is paused to avoid duplicating a request.",
} as const;
const runtimeEn = {
	title: "Agent runtime and settings",
	confirm: "Apply Agent change?",
	warning:
		"Changes may interrupt active work and channel connections. Stopping compute does not cancel its subscription. Resetting dashboard access invalidates existing browser access.",
	apply: "Apply confirmed change",
	start: "Start runtime",
	stop: "Stop runtime",
	restart: "Restart runtime",
	resetAccess: "Reset dashboard access",
	deleteAgent: "Delete Agent, keep subscription",
	deleteWarning:
		"This permanently deletes the Agent and its saved data. This cannot be undone. Any paid subscription is kept and may continue billing; manage it separately through its original purchase provider. Only confirm if you want to delete this Agent without cancelling its subscription.",
	deleteReported:
		"The server reports this Agent deleted for your account. Cleanup may still be in progress. This action did not request subscription cancellation.",
	supportFailed: "Couldn't open your email app. Email support@clawdi.ai.",
	paymentRequired:
		"Starting requires a server-approved subscription or payment action. No payment is made by these controls.",
	uncertain:
		"The operation may already have been accepted. Its original request is saved on this device for this account and Agent. Retry that exact request to recover, even after reopening the app. Do not issue a replacement action from another device.",
	prepared:
		"The confirmed request was saved before sending. Retry it or discard this unsent request.",
	storageError:
		"The saved operation could not be read. Runtime changes are disabled. Retry loading it; do not clear app data to bypass an uncertain operation.",
	reloadAttempt: "Reload saved operation",
	retry: "Retry original operation",
	conflict:
		"The server rejected the first request because the Agent version changed. Refresh and explicitly review a new change; no automatic overwrite occurs.",
	review: "Discard unsent or rejected request",
	failed:
		"The action was not confirmed. Refresh status and review permissions, provider readiness or the original request before retrying.",
	locale: "Language and timezone",
	default: "Agent default",
	timezone: "IANA timezone (for example America/Los_Angeles)",
	invalidLocale:
		"Choose a supported language and valid timezone, or leave them at the Agent default.",
	saveLocale: "Review language and timezone change",
	model: "AI provider and model",
	modelId: "Model ID",
	modelsInAgent:
		"This connection's models are configured inside the Agent. Applying it will not overwrite its model catalog.",
	unmanaged: "Configured inside Agent",
	unmanagedWarning:
		"This removes Clawdi's provider binding and keeps the Agent's own settings. It does not revoke the saved provider account.",
	providerConflict:
		"The Agent reported a provider configuration conflict. Its own settings may take precedence. Review the binding before changing it.",
};
const deploymentsEn = {
	openDashboard: "Open Agent dashboard",
	browserWarning:
		"Open the runtime in the system browser. OpenClaw receives an access credential; the browser may retain access after you sign out of this app. Hermes may require a separate browser sign-in: use the same Clawdi account. Closing the browser does not revoke access; use Reset dashboard access when needed.",
	browserUnavailable:
		"An authenticated browser endpoint is not available yet. Refresh deployment status.",
	browserFailed:
		"Could not open the dashboard. Refresh deployment status and try again. No credentials have been saved by this app.",
	unavailable: "Cloud deployment access is not configured.",
	refresh: "Refresh status",
	timeout: "Automatic status checks have paused. Refresh to check again.",
	agent: "View Cloud Agent",
	agentUnavailable: "Cloud Agent identity is not available yet.",
	operation: "Operation",
	complete: "Complete",
	operationCancelled: "Operation cancelled",
	progress: "In progress",
	cancelChange: "Request cancellation of this change",
	cancelWarning:
		"Cancellation is not immediate and may be rejected or require recovery. Do not assume already-applied work is undone, or that the Agent or its subscription is stopped. Check the final operation status before making another change.",
	cancelRequested:
		"Cancellation requested. Waiting for the server's final operation status; the Agent and its billing have not been declared stopped.",
	cancelUncertain:
		"Cancellation was not confirmed. Refresh the operation status. Retrying this same operation reuses the original cancellation key; no new Agent change is sent.",
	failed: "Deployment failed",
} as const;
const workspaceSkillsEn = {
	title: "Workspace GitHub Skills",
	description:
		"Manage GitHub Skills requested for this hosted Agent. Library references and runtime plugins are not managed on this screen.",
	source: "GitHub owner/repo or owner/repo/path",
	install: "Request installation",
	uninstall: "Request removal",
	confirm: "Change Workspace Skills?",
	warning:
		"This updates the Agent's desired Skill manifest. Runtime application may complete later. Existing Cloud library Skills are not modified.",
	unavailable:
		"New changes are unavailable until the Agent's capability and current version are confirmed.",
	managed: "Managed",
	requested: "Requested — refresh to check runtime status",
	failed: "Runtime application failed — refresh to review status",
	accepted:
		"Desired state accepted. Refresh to inspect runtime status; this is not proof the runtime has finished applying it.",
	open: "Read Skill",
	empty: "No GitHub Skills in the desired manifest.",
	uncertain:
		"An unresolved request is saved. Retry its exact body, resource version and key; refreshing does not prove whether it was accepted.",
	retry: "Retry saved request",
	discard: "Discard unsubmitted or rejected request",
	discardWarning:
		"Discard this local request and reload the current manifest? No uncertain request can be discarded here.",
	storageError:
		"Saved request could not be read or changed. Reload recovery before starting another change.",
	reload: "Reload recovery",
	error:
		"The action was not confirmed. Review current state and the saved request before continuing.",
};
const skillArchiveEn = {
	title: "Skill packages",
	open: "Download, upload or transfer package",
	key: "Skill key (for example: tools/research)",
	upload: "Choose and upload new package",
	replace: "Replace package",
	replaceWarning:
		"Replace this Skill's files with the selected tar.gz package? Refresh first if another device may have changed it. This upload is not automatically retried.",
	hint: "Choose a tar.gz Skill package up to 25 MiB. The server validates its contents. New uploads never overwrite an existing Skill.",
	download: "Download and share package",
	target: "Destination Project",
	copy: "Copy to Project",
	move: "Move to Project",
	moveWarning:
		"Copy the package to the selected Project, then remove the source only if its content has not changed. If removal fails, both copies remain.",
	uploaded: "Package uploaded.",
	copied: "Package copied. Source retained.",
	moved: "Package moved.",
	partial:
		"Package copied, but source removal was not confirmed. Refresh both Projects before making another change.",
	failed:
		"The action was not confirmed. Refresh the source and destination before retrying; an upload or removal may already have succeeded.",
	cacheHint:
		"Downloaded packages stay in this account's app cache so receiving apps can finish reading them. Sharing does not confirm delivery. Clear exports when finished.",
	clear: "Clear cached Skill exports",
	clearWarning:
		"Remove this account's downloaded Skill packages from this app's cache? Wait until receiving apps have finished reading. This does not delete server Skills or copies saved elsewhere.",
	cleared: "Cached exports cleared.",
};
const vaultEn = {
	splitTitle: "Split by app prefix",
	splitSlug: "Destination slug",
	splitComplete: "Complete",
	splitIncomplete: "Incomplete or unconfirmed",
	splitInspect:
		"New Vaults are not linked to Projects automatically. Failed or interrupted operations may leave destinations behind. Inspect both source and destinations before trying again; existing Vaults are never reused automatically.",
	splitReset: "Close report and review remaining keys",
	supplyTitle: "Supply requested credentials",
	supplyReceived:
		"Request link received. Inspect it before entering credentials. Nothing has been submitted.",
	supplyLink: "HTTPS request link",
	supplyLoad: "Inspect request",
	supplyName: "Field name",
	supplyValue: "Secret value",
	supplyAdd: "Add field",
	supplyRemove: "Remove added field",
	supplyImport: "Import dotenv assignments",
	supplyReview: "Check fields and review",
	supplySave: "Save credentials",
	supplyWarning:
		"Save all entered fields to this Vault? The following existing keys will be replaced:",
	supplyNoUpdates: "No existing keys will be replaced.",
	supplyReceipt: "Share completion receipt",
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
	name: "Vault name",
	slug: "Vault slug",
	create: "Create Vault",
	open: "Open Vault",
	refresh: "Refresh",
	keys: "Keys",
	section: "Section (empty for default)",
	importText: "Paste dotenv or flat JSON",
	import: "Import keys",
	importWarning:
		"This writes secrets to the selected Vault and affects every Project using it. Existing keys are skipped unless you enable replacement. Continue?",
	invalidImport:
		"Invalid import. Check key names, duplicates, and quoting. Nothing will be imported.",
	clear: "Clear pasted secrets",
	failed: "The operation could not be confirmed. Refresh before trying again.",
	saved: "Operation completed.",
	remove: "Delete Vault",
	deleteKey: "Delete key",
	detach: "Detach Project",
	attach: "Attach to Project",
	attachTarget: "Choose a project",
	attachWarning:
		"Give this Project and its Agents access to this Vault? Existing secrets remain in the selected Vault.",
	detachWarning:
		"Remove this Project's access to the Vault? Its Agents may no longer receive these secrets. The Vault and keys remain.",
	copySelected: "Copy selected keys",
	moveSelected: "Move selected keys",
	selectedCopyWarning:
		"Matching destination keys will be overwritten. Copies are independent: later changes do not sync. To share one source of truth, attach this Vault to another Project instead. Values remain server-side.",
	moveWarning:
		"Matching destination keys will be overwritten, then confirmed copied keys will be deleted from this Vault for EVERY attached Project. This is a non-atomic copy followed by delete; avoid editing these keys concurrently. Partial results are possible. Values remain server-side.",
	copiedCount: "Confirmed copies",
	copyUnconfirmed: "Copy incomplete or unconfirmed; check both Vaults before retrying",
	cleanupUnconfirmed: "Source deletion skipped or unconfirmed; check source keys",
	loadTargets: "Load more destinations",
	defaultSection: "Default section",
} as const;

import {
	billingCopy,
	LIBRARY_COPY,
	sessionDetailCopy,
	settingsCopy,
	usageCopy,
} from "@clawdi/shared/view";
export const en = {
	settingsParity: settingsCopy,
	billingParity: billingCopy,
	usageParity: usageCopy,
	sessionDetail: sessionDetailCopy,
	libraryPort: LIBRARY_COPY,
	composite: {
		open: "Open",
		close: "Close",
		confirm: "Confirm",
		cancel: "Cancel",
		errorTitle: "Couldn't load this",
		expiredTitle: "Your session expired",
		signInAgain: "Sign in again",
		retry: "Retry",
		expired: "Your session expired. Sign in again to continue.",
		suspended: "Your account has been deactivated and can no longer access Clawdi.",
		timeout: "This is taking longer than usual. Check your connection and try again.",
		offline: "We couldn't reach the service. Check your connection and try again.",
		serviceError: "The service is having trouble right now. Try again in a moment.",
		requestError: "The request couldn't be completed. Review the details and try again.",
		genericError: "Couldn't complete the request. Try again.",
		codeText: "text",
	},
	terminal: {
		unavailable:
			"Terminal access requires a configured compute API and an eligible running deployment. Reload to check its current state.",
		reconnect: "Reconnect terminal",
		title: "Terminal",
		connect: "Connect terminal",
		disconnect: "Disconnect terminal",
		reload: "Reload deployment",
		warning:
			"Commands run on your Agent. Leaving this screen or backgrounding the app disconnects this terminal; it does not stop Agent compute or guarantee running commands are terminated.",
		connecting: "Connecting…",
		connected: "Connected",
		reconnecting: "Reconnecting…",
		disconnected: "Disconnected",
	},
	files: {
		webOnlyTitle: "Files opens on the web",
		webOnlyDescription:
			"Browse and edit this agent's workspace files from the Clawdi web dashboard, or use Terminal now.",
	},
	profile: {
		unsavedTitle: "Discard profile changes?",
		discard: "Discard changes",
	},
	appearance: {
		failed: "Could not read or save your appearance preference. Please retry.",
		retry: "Retry loading appearance",
	},
	settingsMenu: {
		generalSummary: "Appearance",
		generalDescription: "Appearance preferences for this device.",
	},
	publicSession: {
		open: "Open a shared Session",
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
	skillArchive: skillArchiveEn,
	agentSettings: agentSettingsEn,
	runtime: runtimeEn,
	channels: channelsEn,
	whatsapp: whatsappEn,
	providers: {
		removalUnavailable: "Provider removal requires a configured Hosted API.",
		reviewRemoval: "Review provider removal",
		reviewCurrentImpact: "Review current impact again",
		removalUncertain:
			"The previous removal may already have unset Agent configurations. Retry its exact confirmation to recover. Reviewing a new impact does not undo that request.",
		retryRemoval: "Retry previous removal",
		removalFailed:
			"Removal was not confirmed. Retry the original request, or review current impact and explicitly approve it again if the provider changed.",
		connectOAuth: "Connect ChatGPT",
		reconnectOAuth: "Reconnect ChatGPT",
		stopOAuth: "Stop waiting",
		oauthOffline: "Offline. Checking will resume when connectivity returns.",
		oauthReady: "Connection authorized.",
		retrySame: "Retry the same request",
		uncertain:
			"A save may have reached the server. Retry the same request, or refresh the list before starting another connection. Leaving this screen clears the entered key.",
		validate: "Validate configuration",
		valid: "Configuration is valid. This does not test the upstream connection.",
		invalid: "Configuration needs attention. Review this connection's settings.",
		failed:
			"Could not complete the action. Refresh to check the current state before trying again.",
	},
	vault: vaultEn,
	connectors: connectorsEn,
	billing: billingEn,
	creation: creationEn,
	store: storeEn,
	deployments: deploymentsEn,
	app: {
		name: "Clawdi",
	},
	navigation: {
		home: "Overview",
		agents: "Agents",
		sessions: "Sessions",
		library: "Library",
		vaults: "Vaults",
		account: "Account",
		back: "Back",
		deployments: "Deployments",
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
		statsSkills: "Skills",
	},
	inventory: {
		loadMore: "Load more",
		refresh: "Refresh",
		notFound: "This item is unavailable or no longer exists.",
		viewAll: "View all",
		viewDetails: "Details",
	},
	agents: {
		title: "Cloud Agents",
	},
	sessionFilters: {
		search: "Search Sessions and messages…",
		searchInvalid: "Enter 2–500 characters, or clear the search.",
		options: "Filters and sorting",
		agent: "Agent type",
		all: "All",
		allProfiles: "All profiles",
		type: "Session type",
		manual: "Manual",
		automated: "Automated (cron, heartbeat)",
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
		earlier: "Load earlier activity",
		later: "Load later activity",
		moreText: "Show more text",
	},
	sessions: {
		filter: "Sessions for this Agent",
		clearFilter: "Show all Sessions",
		noMessages: "No message transcript is available yet.",
		revisionChanged: "The transcript changed. Refresh to load its current version.",
		filterInvalid: "The Agent filter is invalid.",
	},
	skills: {
		chooseProject:
			"This Library link is read-only. Open the Skill from its Project to edit or manage that exact copy.",
		saved: "Skill saved. You can return to the Skills list.",
		project: "Project",
		create: "Create or import a Skill",
		save: "Save Skill",
		description: "Description",
		remove: "Delete Skill",
		discard: "Discard draft and reload",
		discardWarning: "Your unsaved changes will be lost.",
		readOnly:
			"Only owned cloud Projects can be edited. Agent-synced and shared Skills are read-only.",
		noContent: "No text content is available.",
		import: "Import from GitHub",
		github: "owner/repository/path or an HTTPS GitHub URL",
		conflict:
			"This Skill changed while you were editing. Your draft is preserved. Copy your changes before discarding and reloading.",
		failed: "The change could not be confirmed. Check the current Skill before retrying.",
		title: "Skills",
		empty: "No skills are available for this account.",
	},
	memories: {
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
		open: "Open project",
		filter: "Project scope",
		agentsScope: "Your Agents linked to this Project. Other members' Agents are not listed.",
		all: "All projects",
		choose: "Choose a project",
		sharing: "Manage sharing",
		leave: "Leave project",
		create: "New project",
		edit: "Edit project",
		name: "Project name",
		save: "Save project",
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
		joinLink: "Join using an invite link",
		joinDescription:
			"Paste an HTTPS invite link to preview it against your configured Clawdi server. Joining grants project membership but does not attach an Agent. The link is cleared when you leave or background the app.",
		pasteLink: "Invite link",
		invalidLink: "Enter a valid HTTPS project invite link.",
		preview: "Preview project",
		join: "Join this project",
		joined: "Joined. The project is now available in your project list.",
		joinFailed:
			"This link may be invalid, expired, revoked, or belong to your own project. Check your project list before retrying a join.",
		vaults: "Vaults",
		received: "Project invitations",
		receivedDescription:
			"Review projects shared with you. Accepting adds membership; it does not automatically attach any Agent.",
		noInvitations: "No pending invitations.",
		accept: "Accept invitation",
		decline: "Decline invitation",
		responseFailed: "The invitation may have changed or expired. Refresh before trying again.",
		unavailable: "Only the owner of an active user-created project can manage sharing.",
		email: "Existing account email",
		invite: "Invite account",
		label: "Link label (optional)",
		createLink: "Create invite link",
		shareLink: "Share invite link",
		once: "This link grants access to the project. It is shown once and hidden when you leave this screen or background the app.",
		dismiss: "Hide link",
		failed:
			"The change could not be confirmed. Refresh before retrying. Invitations require an existing account and sharing requires a profile display name.",
		stop: "Stop all sharing",
		active: "Active",
		inactive: "Expired or revoked",
		redemptions: "redemptions",
		revoke: "Revoke link",
		cancelInvite: "Cancel invitation",
		removeMember: "Remove member",
	},
	account: {
		cancel: "Cancel",
		actionFailed: "The action could not be confirmed. Refresh the key list before trying again.",
	},
} as const;
export type TranslationKey = {
	[Scope in keyof typeof en]: `${Scope}.${keyof (typeof en)[Scope] & string}`;
}[keyof typeof en];
