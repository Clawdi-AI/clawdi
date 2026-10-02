export const en = {
	app: {
		name: "Clawdi",
	},
	navigation: {
		home: "Home",
		account: "Account",
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
		workspaceTitle: "Your Agent workspace",
		workspaceMessage: "Your mobile foundation is ready. Agent inventory and sessions will appear here.",
		emptyTitle: "No Agents to show",
		emptyMessage: "When an Agent is available for this account, its status will appear here.",
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
	| "loading.app"
	| "loading.authentication"
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
	| "home.workspaceTitle"
	| "home.workspaceMessage"
	| "home.emptyTitle"
	| "home.emptyMessage"
	| "account.title"
	| "account.signedInAs"
	| "account.signOut"
	| "account.signOutFailed"
	| "account.accountUnavailable"
	| "error.genericTitle"
	| "error.genericMessage"
	| "error.tryAgain"
	| "error.offline";
