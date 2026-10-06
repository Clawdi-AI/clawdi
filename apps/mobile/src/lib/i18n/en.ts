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
	links: "Linked Agents",
	link: "Link selected Agent",
	replace: "Replace this Agent's existing channel for this provider",
	replaceWarning:
		"Replacement disconnects the previous bot for this provider. Paired chats may lose access.",
	selectAgent: "Select an Agent",
	unlink: "Unlink Agent",
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
	review: "Review Custom bots",
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
	attachTarget: "Choose a Project",
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

import { billingCopy, LIBRARY_COPY, sessionDetailCopy, settingsCopy } from "@clawdi/shared/view";
export const en = {
	settingsParity: settingsCopy,
	billingParity: billingCopy,
	sessionDetail: sessionDetailCopy,
	libraryPort: LIBRARY_COPY,
	composite: {
		open: "Open",
		close: "Close",
		confirm: "Confirm",
		cancel: "Cancel",
		search: "Search",
		searchPlaceholder: "Search…",
		clearSearch: "Clear search",
		errorTitle: "Couldn't load this",
		expiredTitle: "Your session expired",
		signInAgain: "Sign in again",
		retry: "Retry",
		expired: "Your session has expired. Please sign in again to continue.",
		suspended: "Your account has been deactivated and can no longer access Clawdi.",
		timeout: "This is taking longer than usual. Check your connection and try again.",
		offline: "We couldn't reach the service. Check your connection and try again.",
		serviceError: "The service is having trouble right now. Please try again in a moment.",
		requestError: "The request could not be completed. Review the details and try again.",
		genericError: "Something went wrong. Please try again.",
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
	connections: {
		title: "Connected accounts",
		description: "Manage accounts connected to your profile.",
		empty: "No third-party accounts are connected.",
		verified: "Verified connection",
		unverified: "Connection is not verified",
		remove: "Disconnect account",
		removeWarning:
			"Remove this sign-in connection? Make sure you have another way to sign in. Provider-backed access may stop working. Your account service may require fresh verification or prevent removal of your last sign-in method.",
		reauthorize: "Reauthorize in browser",
		reauthorized: "Connection authorization confirmed.",
		connect: "Connect account",
		notConfigured: "No new sign-in providers are configured for this app build.",
		browserHint: "Connect an account to use it for sign-in.",
		failed:
			"Could not confirm this change. Refresh before retrying. Your sign-in service may require additional verification, deny this provider or restrict changing connections.",
		saved: "Connection removed.",
	},
	mfa: {
		title: "Two-factor authentication",
		smsTitle: "SMS verification",
		smsDescription: "Use a verified phone number to receive sign-in codes.",
		smsEnable: "Enable SMS two-factor verification",
		smsDisable: "Disable SMS two-factor verification",
		smsDefault: "Use as preferred SMS number",
		smsPreferred: "Preferred SMS number",
		smsEnabled: "Enabled for SMS two-factor verification",
		smsDisabled: "Not enabled for SMS two-factor verification",
		smsEnableWarning:
			"Use this verified number for two-factor sign-in? Ensure you can receive SMS at this number. An authenticator remains the preferred method when enabled. Save any returned backup codes before leaving this screen.",
		smsDisableWarning:
			"Stop using this number as a second factor? This does not delete the phone number. The account service may prevent removal of a required security factor.",
		description: "Add an extra layer of security to your account.",
		enabled: "Authenticator enabled.",
		disabled: "Authenticator not enabled.",
		setup: "Set up authenticator",
		setupInstructions:
			"Scan this QR code with an authenticator, or enter the secret manually. Switching apps hides the secret; return here to enter the generated code.",
		qr: "Authenticator setup QR code",
		codeHint: "Enter the code from your authenticator app.",
		code: "Authenticator code",
		verify: "Verify and enable authenticator",
		disable: "Disable authenticator",
		discard: "Discard pending authenticator setup",
		disableWarning:
			"Remove the authenticator secret from this account? If enabled, authenticator codes will stop working. Other account sign-in policies still apply.",
		backup: "Generate new backup codes",
		backupWarning:
			"Generate a new set? All previous backup codes will stop working. Save the new codes somewhere secure before leaving this screen.",
		saveCodes:
			"Keep these one-use codes somewhere secure. They disappear when you leave or background the app. Generating another set invalidates these codes.",
		hide: "Hide secrets",
		failed:
			"Could not confirm this change. Refresh to check account state before retrying. Your account policy, code or verification requirements may prevent the action.",
		saved: "Security settings updated.",
	},
	password: {
		title: "Password",
		description: "Update the password you use to sign in.",
		enabled: "This account has a password.",
		absent: "This account does not currently have a password.",
		current: "Current password",
		new: "New password",
		confirm: "Confirm new password",
		otherSessions: "Sign out other sessions when updating the password",
		update: "Update password",
		add: "Add password",
		remove: "Remove password",
		removeWarning:
			"Remove password sign-in? You must have another permitted way to sign in. The account service will check whether removal is allowed. This does not delete your account.",
		failed:
			"Could not confirm the password change. Check your current password and account password requirements. If the connection was lost, try signing in with the new password before retrying; the change may already have succeeded.",
		saved: "Password settings updated.",
	},
	devices: {
		title: "Signed-in devices",
		description: "Manage devices signed in to your account.",
		refresh: "Load or refresh devices",
		loadHint: "Load the current device list. It is cleared when you leave or background the app.",
		unknown: "Unknown device or activity",
		lastActive: "Last active:",
		current: "This session",
		revoke: "Sign out this session",
		warning:
			"Sign out the selected session? That device will need to sign in again. This does not delete your account or cancel subscriptions.",
		revoked: "The selected session is no longer active.",
		failed:
			"Could not confirm the device list or session change. Refresh and try again. An empty or stale response is not treated as a successful security check.",
	},
	reverification: {
		title: "Verify your identity",
		description:
			"This account change needs a fresh identity check. Once verified, the original request will be tried once more. Leaving this screen or backgrounding the app cancels it.",
		start: "Start verification",
		password: "Password",
		email_code: "Email code",
		phone_code: "SMS code",
		totp: "Authenticator code",
		backup_code: "Backup code",
		inputHint:
			"Enter the selected password or code. Select the delivery method again to resend a code.",
		verify: "Verify and continue",
		unsupported:
			"This account requires a verification method not yet supported here. Cancel and use the Web account settings.",
		failed:
			"Verification failed. Check your password or code and try again, or cancel to start over.",
	},
	emails: {
		title: "Email addresses",
		description:
			"Add and verify an address before making it primary. Your primary address cannot be removed here. Account security requirements still apply.",
		primary: "Primary email",
		verified: "Verified",
		unverified: "Not verified",
		input: "New email address",
		add: "Add email address",
		sendCode: "Send verification code",
		codeSent: "Enter the code sent to this email address. Use Send verification code to resend.",
		code: "Verification code",
		verify: "Verify email address",
		makePrimary: "Make primary",
		primaryWarning: "Use this verified email as your primary account address?",
		remove: "Remove email address",
		removeWarning: "Remove this email from your account? It may no longer be used to sign in.",
		failed:
			"Could not complete this request. Check the address or code and refresh before retrying. Your account may require signing in again or a different verification method.",
		saved: "Email address updated.",
	},
	phones: {
		title: "Phone numbers",
		description:
			"Add and verify a phone number before making it primary. Enter the full international number, starting with + and the country code (for example +14155552671). Your primary number cannot be removed here. This does not enable SMS two-factor authentication.",
		primary: "Primary phone number",
		verified: "Verified",
		unverified: "Not verified",
		input: "New phone number (+country code and number)",
		add: "Add phone number",
		sendCode: "Send verification code",
		codeSent: "Enter the SMS code sent to this number. Use Send verification code to resend.",
		code: "Verification code",
		verify: "Verify phone number",
		makePrimary: "Make primary",
		primaryWarning: "Use this verified phone number as your primary account number?",
		remove: "Remove phone number",
		removeWarning:
			"Remove this phone number from your account? Sign-in and SMS verification using this number may no longer work. Account security requirements still apply.",
		failed:
			"Could not complete this request. Check the international number or SMS code and refresh before retrying. Phone verification may not be available for your account or region, or further account verification may be required.",
		saved: "Phone number updated.",
	},
	deletion: {
		title: "Delete account",
		warning:
			"This permanently terminates your Clawdi account and starts cleanup of hosted Agents, credentials and associated account data. You will lose access. Cleanup may continue asynchronously. This is not a refund request; do not assume an Apple or Google subscription is cancelled—manage store subscriptions in the store where you purchased them.",
		phrase: "DELETE",
		typePhrase: "Type DELETE to continue",
		confirm: "Permanently delete account",
		unavailable:
			"Account deletion requires the hosted account service. It is not configured in this build; use Clawdi on the web or contact support.",
		accepted:
			"The account service acknowledged your deletion request. Resource cleanup may still be running. Sign out of this device; this screen cannot verify final cleanup or subscription cancellation.",
		uncertain:
			"Deletion has not been confirmed. The request may already have been accepted. Do not assume your account or subscriptions are unchanged. Sign out and contact support to verify the outcome; no request will be retried automatically.",
	},
	profile: {
		avatar: "Profile picture",
		avatarSaved: "Profile picture updated. Any unsaved profile changes still need to be saved.",
		avatarHint:
			"Choose a PNG, JPEG or WebP image up to 2 MiB. It will be uploaded to your account.",
		uploadAvatar: "Change profile picture",
		removeAvatar: "Remove profile picture",
		removeAvatarWarning: "Remove your custom account picture? Your account name will not change.",
		unsavedTitle: "Discard profile changes?",
		unsavedMessage: "Your profile changes have not been saved.",
		discard: "Discard changes",
		title: "Edit profile",
		description: "Manage your profile information.",
		firstName: "First name",
		lastName: "Last name",
		username: "Username",
		usernameHint: "Your username must be unique.",
		save: "Save profile",
		saved: "Profile saved.",
		failed:
			"Could not save your profile. Check your connection and account requirements, then retry.",
	},
	appearance: {
		failed: "Could not read or save your appearance preference. Please retry.",
		retry: "Retry loading appearance",
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
	passkeys: {
		title: "Passkeys",
		description: "Manage passkeys registered with your Clawdi account.",
		empty: "No registered passkeys.",
		unnamed: "Unnamed passkey",
		lastUsed: "Last used:",
		neverUsed: "Not available",
		name: "Passkey name",
		rename: "Rename",
		save: "Save name",
		remove: "Remove passkey",
		removeWarning:
			"This passkey will no longer sign in to your account. Make sure you have another sign-in method. This does not delete the credential from your device or password manager.",
		nativeUnavailable:
			"Creating a passkey and signing in with one are not available in this build yet. Existing passkeys can still be used on the web.",
		failed: "The passkey change could not be confirmed. Refresh and try again.",
		saved: "Passkey change confirmed.",
	},
	signupDetails: {
		first_name: "First name",
		last_name: "Last name",
		username: "Username",
		email_address: "Email address",
		phone_number: "Phone number with +country code",
		password: "New password",
		email_address_or_phone_number: "Email or international phone number",
		description: "Your sign-in service requires these details to finish creating your account.",
		continue: "Continue registration",
		phoneCode: "Enter the verification code sent to your phone.",
		unsupported:
			"This registration requires a policy agreement, security challenge or verification method not yet supported here. No agreement has been accepted on your behalf.",
	},
	auth: {
		devBypassUnavailable: "Account management unavailable",
		devBypassDescription:
			"Sign in with your Clerk account to manage your profile and security settings.",
		signInTitle: "Sign in to Clawdi",
		signInSubtitle: "Use your Clawdi account to continue.",
		signUpTitle: "Create your Clawdi account",
		signUpSubtitle: "Create an account to manage your Agents.",
		email: "Email address",
		password: "Password",
		signIn: "Sign in",
		signUp: "Create account",
		noAccount: "New to Clawdi?",
		haveAccount: "Already have an account?",
		createAccount: "Create an account",
		returnToSignIn: "Return to sign in",
		unavailable: "Authentication is not ready yet.",
		failed: "We could not complete authentication. Check your details and try again.",
		working: "Please wait…",
		verificationCode: "Verification code",
		authenticatorCode: "Authenticator code",
		backupCode: "Backup code",
		codeSubtitle: "Enter your verification code to continue.",
		verify: "Verify and continue",
		resendCode: "Resend code",
		codeSentTo: "Code sent to",
		codeSent: "A new verification code has been sent.",
		useBackupCode: "Use a backup code",
		forgotPassword: "Forgot password?",
		signInWithEmailCode: "Email me a sign-in code",
		continueWith: "Continue with",
		recoveryTitle: "Reset your password",
		recoverySubtitle: "Receive a code at your account email address.",
		sendRecoveryCode: "Send recovery code",
		newPassword: "New password",
		resetPassword: "Reset password and sign in",
		startOver: "Start over",
		unsupportedVerification:
			"This account requires a verification method or account details that this app does not support. Continue on the web or contact your administrator.",
		sessionTaskRequired:
			"Your account has a required setup step. Complete it on the web before using the mobile app.",
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
		open: "Open Project",
		filter: "Project scope",
		agentsScope: "Your Agents linked to this Project. Other members' Agents are not listed.",
		all: "All Projects",
		choose: "Choose a Project",
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
		profile: "Profile",
		security: "Security",
		settings: "Settings",
		signOut: "Sign out",
		signOutFailed: "We could not sign you out. Please try again.",
		accountUnavailable: "Account details are not available yet.",
		createApiKey: "Create API key",
		revokeApiKey: "Revoke API key",
		cancel: "Cancel",
		dismissKey: "I have saved the key",
		actionFailed: "The action could not be confirmed. Refresh the key list before trying again.",
	},
} as const;
export type TranslationKey = {
	[Scope in keyof typeof en]: `${Scope}.${keyof (typeof en)[Scope] & string}`;
}[keyof typeof en];
