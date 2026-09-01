export const DESKTOP_AGENT_TYPES = [
	"claude_code",
	"codex",
	"openclaw",
	"hermes",
	"pi",
	"opencode",
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
}

export interface DesktopAgentConnection {
	type: DesktopAgentType;
	reconnectAgentId?: string;
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

export interface DesktopShellAuthenticationResult {
	status: "authenticated" | "cancelled";
}

export interface DesktopMoveToApplicationsResult {
	status: "cancelled" | "not-required" | "relaunching";
}

export interface ClawdiDesktopConnectBridge {
	getBootstrapState(): Promise<DesktopBootstrapState>;
	getInstallationState(): Promise<DesktopInstallationState>;
	authenticate(): Promise<DesktopAuthenticationResult>;
	cancelAuthentication(): Promise<DesktopAuthenticationCancellationResult>;
	detectAgents(): Promise<DesktopDetectedAgent[]>;
	listReconnectableAgents(): Promise<DesktopReconnectCandidate[]>;
	connectAgents(connections: DesktopAgentConnection[]): Promise<DesktopConnectResult>;
	moveToApplicationsFolder(): Promise<DesktopMoveToApplicationsResult>;
	openDashboard(): Promise<void>;
}

export interface ClawdiDesktopShellBridge {
	signIn(): Promise<DesktopShellAuthenticationResult>;
	signOut(): Promise<void>;
	openConnectWizard(): Promise<void>;
	retryDashboard(): Promise<void>;
}
