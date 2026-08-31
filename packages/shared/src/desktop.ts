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

export interface DesktopMoveToApplicationsResult {
	status: "cancelled" | "not-required" | "relaunching";
}

export interface DesktopLocalSession {
	id: string;
	agent: DesktopAgentType;
	agentName: string;
	project: string | null;
	startedAt: string;
	endedAt: string | null;
	messageCount: number;
	durationSeconds: number | null;
	model: string | null;
	summary: string | null;
}

export interface DesktopLocalSessionMessage {
	role: "user" | "assistant";
	content: string;
	model: string | null;
	timestamp: string | null;
}

export interface DesktopLocalSessionDetail {
	session: DesktopLocalSession;
	messages: DesktopLocalSessionMessage[];
}

export interface DesktopDashboardState {
	auth: DesktopBootstrapState["auth"];
	daemon: DesktopBootstrapState["daemon"];
	sessions: DesktopLocalSession[];
}

export interface ClawdiDesktopConnectBridge {
	getBootstrapState(): Promise<DesktopBootstrapState>;
	getInstallationState(): Promise<DesktopInstallationState>;
	authenticate(): Promise<DesktopAuthenticationResult>;
	cancelAuthentication(): Promise<DesktopAuthenticationCancellationResult>;
	detectAgents(): Promise<DesktopDetectedAgent[]>;
	connectAgents(agentTypes: DesktopAgentType[]): Promise<DesktopConnectResult>;
	moveToApplicationsFolder(): Promise<DesktopMoveToApplicationsResult>;
	openDashboard(): Promise<void>;
}

export interface ClawdiDesktopShellBridge {
	getDashboardState(): Promise<DesktopDashboardState>;
	readLocalSession(agent: DesktopAgentType, sessionId: string): Promise<DesktopLocalSessionDetail>;
	openConnectWizard(): Promise<void>;
}
