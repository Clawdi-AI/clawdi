export const en = {
	app: {
		name: "Clawdi",
	},
	navigation: {
		home: "Home",
		account: "Account",
		back: "Back",
	},
	loading: {
		app: "Loading Clawdi",
		authentication: "Checking your account",
		agents: "Loading Agents",
		agent: "Loading Agent",
		sessions: "Loading Sessions",
		session: "Loading Session",
	},
	configuration: {
		title: "Clawdi needs configuration",
		message: "Ask your administrator to provide the mobile API and authentication configuration.",
		missing: "Required configuration is missing.",
		invalid: "The mobile configuration is invalid.",
	},
	auth: {
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
		verificationRequired: "This account needs an additional verification step.",
	},
	home: {
		greeting: "Welcome back",
		agentsTitle: "Cloud Agents",
		sessionsTitle: "Recent Sessions",
		workspaceTitle: "Your Agent workspace",
		workspaceMessage:
			"Your mobile foundation is ready. Agent inventory and sessions will appear here.",
		emptyTitle: "No Agents to show",
		emptyMessage: "When an Agent is available for this account, its status will appear here.",
	},
	inventory: {
		viewAll: "View all",
		viewDetails: "Details",
	},
	agents: {
		title: "Cloud Agents",
		description: "Agents connected to your Clawdi account.",
		detailDescription: "Read-only Agent information from Cloud.",
		empty: "No Cloud Agents are available for this account.",
		type: "Agent type",
		machine: "Machine",
		operatingSystem: "Operating system",
		version: "Version",
		lastSeen: "Last seen",
		lastSync: "Last sync",
		neverSeen: "Never seen",
		unknown: "Unknown",
		syncEnabled: "Sync enabled",
		adapters: "Adapters",
	},
	sessions: {
		title: "Sessions",
		description: "Read-only history from your Cloud Agents.",
		detailDescription: "Read-only Session information from Cloud.",
		empty: "No Sessions are available for this account.",
		agent: "Agent",
		status: "Status",
		project: "Project",
		localId: "Local Session ID",
		started: "Started",
		lastActivity: "Last activity",
		ended: "Ended",
		inProgress: "In progress",
		messages: "Messages",
		model: "Model",
		unknownModel: "Unknown model",
		unknownAgent: "Unknown Agent",
		unknownProject: "Unknown project",
		unknownActivity: "Unknown activity",
		tags: "Tags",
	},
	common: {
		yes: "Yes",
		no: "No",
	},
	account: {
		title: "Account",
		signedInAs: "Signed in as",
		signOut: "Sign out",
		signOutFailed: "We could not sign you out. Please try again.",
		accountUnavailable: "Account details are not available yet.",
	},
	error: {
		genericTitle: "Something went wrong",
		genericMessage: "Try again. If the problem continues, check your connection.",
		tryAgain: "Try again",
		offline: "You appear to be offline.",
	},
} as const;

export type TranslationKey =
	| "app.name"
	| "navigation.home"
	| "navigation.account"
	| "navigation.back"
	| "loading.app"
	| "loading.authentication"
	| "loading.agents"
	| "loading.agent"
	| "loading.sessions"
	| "loading.session"
	| "configuration.title"
	| "configuration.message"
	| "configuration.missing"
	| "configuration.invalid"
	| "auth.signInTitle"
	| "auth.signInSubtitle"
	| "auth.signUpTitle"
	| "auth.signUpSubtitle"
	| "auth.email"
	| "auth.password"
	| "auth.signIn"
	| "auth.signUp"
	| "auth.noAccount"
	| "auth.haveAccount"
	| "auth.createAccount"
	| "auth.returnToSignIn"
	| "auth.unavailable"
	| "auth.failed"
	| "auth.verificationRequired"
	| "home.greeting"
	| "home.agentsTitle"
	| "home.sessionsTitle"
	| "home.workspaceTitle"
	| "home.workspaceMessage"
	| "home.emptyTitle"
	| "home.emptyMessage"
	| "inventory.viewAll"
	| "inventory.viewDetails"
	| "agents.title"
	| "agents.description"
	| "agents.detailDescription"
	| "agents.empty"
	| "agents.type"
	| "agents.machine"
	| "agents.operatingSystem"
	| "agents.version"
	| "agents.lastSeen"
	| "agents.lastSync"
	| "agents.neverSeen"
	| "agents.unknown"
	| "agents.syncEnabled"
	| "agents.adapters"
	| "sessions.title"
	| "sessions.description"
	| "sessions.detailDescription"
	| "sessions.empty"
	| "sessions.agent"
	| "sessions.status"
	| "sessions.project"
	| "sessions.localId"
	| "sessions.started"
	| "sessions.lastActivity"
	| "sessions.ended"
	| "sessions.inProgress"
	| "sessions.messages"
	| "sessions.model"
	| "sessions.unknownModel"
	| "sessions.unknownAgent"
	| "sessions.unknownProject"
	| "sessions.unknownActivity"
	| "sessions.tags"
	| "common.yes"
	| "common.no"
	| "account.title"
	| "account.signedInAs"
	| "account.signOut"
	| "account.signOutFailed"
	| "account.accountUnavailable"
	| "error.genericTitle"
	| "error.genericMessage"
	| "error.tryAgain"
	| "error.offline";
