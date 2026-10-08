import type {
	DesktopAuthenticationResult,
	DesktopBootstrapState,
	DesktopDetectedAgent,
} from "@clawdi/shared/desktop";

export type DesktopCliAuthenticationResult =
	| { status: "authenticated"; user: { id: string; email?: string } }
	| { status: "cancelled" };

export interface DesktopAuthCliPort {
	bootstrapState(): Promise<DesktopBootstrapState>;
	authenticate(): Promise<DesktopCliAuthenticationResult>;
}

export interface DesktopStartupCliPort {
	bootstrapState(): Promise<DesktopBootstrapState>;
	detectAgents(): Promise<DesktopDetectedAgent[]>;
	reconcileDaemonRuntime(verifiedAccountId: string): Promise<boolean>;
	restartDaemon(): Promise<void>;
}

/** Sign-in is entered from Welcome; account switching first signs out of Desktop. */
export async function authenticateDesktopAccount(
	cli: DesktopAuthCliPort,
): Promise<DesktopAuthenticationResult> {
	const authentication = await cli.authenticate();
	if (authentication.status === "cancelled") return authentication;
	return { status: "authenticated", state: await cli.bootstrapState() };
}

export async function prepareDesktopStartup(cli: DesktopStartupCliPort): Promise<{
	state: DesktopBootstrapState;
	requiresWizard: boolean;
}> {
	const state = await cli.bootstrapState();
	return { state, requiresWizard: !state.auth.authenticated || !state.auth.user };
}

export async function reconcileDesktopStartupSync(cli: DesktopStartupCliPort): Promise<{
	state: DesktopBootstrapState;
	needsAttention: boolean;
}> {
	let state = await cli.bootstrapState();
	if (!state.auth.authenticated || !state.auth.user || !state.daemon.installed) {
		return { state, needsAttention: false };
	}

	let agents: DesktopDetectedAgent[];
	try {
		agents = await cli.detectAgents();
	} catch {
		return { state, needsAttention: true };
	}
	const verifiedRegistrations = agents.filter(
		(agent) => agent.registered && agent.inspection === "complete",
	);
	if (verifiedRegistrations.length === 0) {
		return { state, needsAttention: true };
	}

	try {
		const rebound = await cli.reconcileDaemonRuntime(state.auth.user.id);
		if (!rebound && !state.daemon.running) await cli.restartDaemon();
		state = await cli.bootstrapState();
		return { state, needsAttention: !state.daemon.running };
	} catch {
		return { state, needsAttention: true };
	}
}
