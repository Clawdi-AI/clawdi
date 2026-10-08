/** OS protocol that Clawdi Desktop registers for links from the dashboard. */
export const DESKTOP_DEEP_LINK_SCHEME = "clawdi-desktop";

/** Opens Clawdi Desktop's Connect window; the only link Desktop accepts. */
export const DESKTOP_CONNECT_DEEP_LINK = `${DESKTOP_DEEP_LINK_SCHEME}://connect`;

/** Clawdi Desktop installers are published as GitHub releases tagged `desktop-v*`. */
export const DESKTOP_DOWNLOAD_URL =
	"https://github.com/Clawdi-AI/clawdi/releases?q=desktop&expanded=true";

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

export interface DesktopShellAuthenticationResult {
	status: "authenticated" | "cancelled";
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

// TODO (2026-10-08): Remove after 2026-11-08; retained for Desktop beta.1–7.
export interface ClawdiDesktopShellBridge {
	/** Absent on the first beta; existing methods form protocol version 1. */
	readonly apiVersion?: 1;
	signIn(): Promise<DesktopShellAuthenticationResult>;
	signOut(): Promise<void>;
	openFilesWindow(url: string): Promise<boolean>;
	openRuntimeWindow(url: string): Promise<boolean>;
	openTerminalWindow(url: string): Promise<boolean>;
	openConnectWizard(): Promise<void>;
	retryDashboard(): Promise<void>;
	createDashboardSession(): Promise<string>;
}
