/** OS protocol that Clawdi Desktop registers; `clawdi-desktop://connect` opens Connect. */
export const DESKTOP_DEEP_LINK_SCHEME = "clawdi-desktop";

export const DESKTOP_AGENT_TYPES = [
	"claude_code",
	"codex",
	"openclaw",
	"hermes",
	"pi",
	"opencode",
	"dsh",
] as const;

export type DesktopAgentType = (typeof DESKTOP_AGENT_TYPES)[number];

export function isDesktopAgentType(value: unknown): value is DesktopAgentType {
	return typeof value === "string" && (DESKTOP_AGENT_TYPES as readonly string[]).includes(value);
}

export interface DesktopDetectedAgent {
	type: DesktopAgentType;
	displayName: string;
	detected: boolean;
	registered: boolean;
	version: string | null;
	inspection: "complete" | "failed";
}

export interface DesktopReconnectCandidate {
	id: string;
	type: DesktopAgentType;
	displayName: string;
	name: string;
	machineName: string;
	isThisMachine: boolean;
	lastSyncAt: string | null;
}

export interface DesktopAgentConnection {
	type: DesktopAgentType;
	reconnectAgentId?: string;
	confirmTakeover?: boolean;
}

export interface DesktopBootstrapState {
	platform: "darwin" | "linux" | "win32";
	cli: {
		status: "ready" | "error";
		version: string | null;
	};
	auth: {
		authenticated: boolean;
		user: { id: string; email?: string } | null;
	};
	daemon: {
		installed: boolean;
		running: boolean;
	};
}

export interface DesktopConnectResult {
	connected: DesktopAgentType[];
	daemonInstalled: boolean;
}

export interface DesktopInstallationState {
	requiresMove: boolean;
}

export type DesktopAuthenticationResult =
	| { status: "authenticated"; state: DesktopBootstrapState }
	| { status: "cancelled" };

export interface DesktopAuthenticationCancellationResult {
	status: "cancelled" | "not-active";
}

export interface DesktopAuthenticationProgress {
	verificationUri: string;
	userCode: string;
	expiresAt: string;
}

export interface DesktopMoveToApplicationsResult {
	status: "cancelled" | "not-required" | "relaunching";
}

export interface DesktopVerificationReopenResult {
	status: "opened" | "not-active";
}

/** Views the tray or app menu can ask the Connect window to show. */
export type DesktopConnectView = "connect" | "fix-sync" | "exclude-projects";

export interface DesktopExcludedProjectAddResult {
	status: "added" | "cancelled" | "exists";
	projects: string[];
}

export interface ClawdiDesktopConnectBridge {
	getBootstrapState(): Promise<DesktopBootstrapState>;
	getInstallationState(): Promise<DesktopInstallationState>;
	authenticate(): Promise<DesktopAuthenticationResult>;
	onAuthenticationProgress(listener: (progress: DesktopAuthenticationProgress) => void): () => void;
	cancelAuthentication(): Promise<DesktopAuthenticationCancellationResult>;
	/** Opens the verification page of the active sign-in again. */
	reopenVerificationPage(): Promise<DesktopVerificationReopenResult>;
	/** Returns and clears the pending tray or app menu request, if any. */
	takeRequestedView(): Promise<DesktopConnectView | null>;
	/** Signals that a request is pending; take it with takeRequestedView. */
	onViewRequested(listener: () => void): () => void;
	listExcludedProjects(): Promise<string[]>;
	/** Lets the user choose a folder in a native dialog, then excludes it. */
	addExcludedProject(): Promise<DesktopExcludedProjectAddResult>;
	removeExcludedProject(path: string): Promise<string[]>;
	detectAgents(): Promise<DesktopDetectedAgent[]>;
	listReconnectableAgents(): Promise<DesktopReconnectCandidate[]>;
	connectAgents(connections: DesktopAgentConnection[]): Promise<DesktopConnectResult>;
	moveToApplicationsFolder(): Promise<DesktopMoveToApplicationsResult>;
	openDashboard(): Promise<void>;
}

export interface DesktopWebSession {
	userId: string;
	sessionId: string;
}

/** accountId is the verified Clerk subject, not the local Clawdi account UUID. */
export type DesktopDashboardSession =
	| { status: "ticket"; ticket: string; accountId: string }
	| { status: "signed-in" | "sign-out"; accountId: string };

/** Minimal capability contract exposed only to the dashboard's main frame. */
export interface ClawdiDesktopBridge {
	readonly version: 1;
	openConnector(): void;
	/** Available only on /desktop-auth; never accepts or reads a URL ticket. */
	createDashboardSession(session: DesktopWebSession | null): Promise<DesktopDashboardSession>;
	signOut(): Promise<void>;
}

export function isClawdiDesktopBridge(value: unknown): value is ClawdiDesktopBridge {
	return (
		typeof value === "object" &&
		value !== null &&
		"version" in value &&
		value.version === 1 &&
		"openConnector" in value &&
		typeof value.openConnector === "function" &&
		"createDashboardSession" in value &&
		typeof value.createDashboardSession === "function" &&
		"signOut" in value &&
		typeof value.signOut === "function"
	);
}
