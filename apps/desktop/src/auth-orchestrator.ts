import type { DesktopBootstrapState, DesktopDetectedAgent } from "@clawdi/shared/desktop";

export type DesktopCliAuthenticationResult =
	| { status: "authenticated"; user: { id: string; email?: string } }
	| { status: "cancelled" };

export interface DesktopAuthCliPort {
	bootstrapState(): Promise<DesktopBootstrapState>;
	getAuthState(): Promise<DesktopBootstrapState["auth"]>;
	authenticate(force?: boolean): Promise<DesktopCliAuthenticationResult>;
	stopDaemon(): Promise<void>;
	restartDaemon(): Promise<void>;
}

export interface DesktopStartupCliPort {
	bootstrapState(): Promise<DesktopBootstrapState>;
	detectAgents(): Promise<DesktopDetectedAgent[]>;
	restartDaemon(): Promise<void>;
}

export type DesktopAuthenticationFlowResult =
	| {
			status: "cancelled";
			restoreDashboard: boolean;
			requiresWizard: boolean;
			needsAttention: boolean;
	  }
	| {
			status: "authenticated";
			accountChanged: boolean;
			requiresWizard: boolean;
			needsAttention: boolean;
	  };

interface FailedAuthenticationRecovery {
	restoreDashboard: boolean;
	requiresWizard: boolean;
	needsAttention: boolean;
}

export class DesktopAuthenticationTransitionError extends Error {
	constructor(
		message: string,
		readonly recovery: FailedAuthenticationRecovery,
		options: ErrorOptions,
	) {
		super(message, options);
		this.name = "DesktopAuthenticationTransitionError";
	}
}

export async function authenticateDesktopAccount(
	cli: DesktopAuthCliPort,
	options: {
		force?: boolean;
		beforeAuthentication?: () => Promise<void>;
	} = {},
): Promise<DesktopAuthenticationFlowResult> {
	const force = options.force === true;
	const preflight = await cli.bootstrapState();
	const previousAuth = preflight.auth;
	const wantsSync = preflight.daemon.installed;
	let daemonStopped = false;

	if (force && wantsSync) {
		await cli.stopDaemon();
		daemonStopped = true;
	}

	let authentication: DesktopCliAuthenticationResult;
	try {
		if (force) await options.beforeAuthentication?.();
		authentication = await cli.authenticate(force);
	} catch (cause) {
		const recovery = daemonStopped
			? await recoverPreviousAccount(cli, previousAuth, wantsSync)
			: defaultFailedRecovery(previousAuth);
		throw new DesktopAuthenticationTransitionError("Desktop sign-in failed.", recovery, {
			cause,
		});
	}

	if (authentication.status === "cancelled") {
		const recovery = daemonStopped
			? await recoverPreviousAccount(cli, previousAuth, wantsSync)
			: defaultFailedRecovery(previousAuth);
		return { status: "cancelled", ...recovery };
	}

	const accountChanged = Boolean(
		previousAuth.authenticated &&
			previousAuth.user?.id &&
			previousAuth.user.id !== authentication.user.id,
	);
	if (accountChanged) {
		return {
			status: "authenticated",
			accountChanged: true,
			requiresWizard: true,
			needsAttention: false,
		};
	}

	const shouldRestart = wantsSync && force;
	if (shouldRestart) {
		try {
			await cli.restartDaemon();
		} catch {
			return {
				status: "authenticated",
				accountChanged: false,
				requiresWizard: true,
				needsAttention: true,
			};
		}
	}

	return {
		status: "authenticated",
		accountChanged: false,
		requiresWizard: false,
		needsAttention: false,
	};
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
	if (
		!state.auth.authenticated ||
		!state.auth.user ||
		!state.daemon.installed ||
		state.daemon.running
	) {
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
		await cli.restartDaemon();
		state = await cli.bootstrapState();
		return { state, needsAttention: !state.daemon.running };
	} catch {
		return { state, needsAttention: true };
	}
}

async function recoverPreviousAccount(
	cli: DesktopAuthCliPort,
	previousAuth: DesktopBootstrapState["auth"],
	wantsSync: boolean,
): Promise<FailedAuthenticationRecovery> {
	let currentAuth: DesktopBootstrapState["auth"];
	try {
		currentAuth = await cli.getAuthState();
	} catch {
		return { restoreDashboard: false, requiresWizard: true, needsAttention: true };
	}
	if (!sameAccountState(previousAuth, currentAuth)) {
		return { restoreDashboard: false, requiresWizard: true, needsAttention: true };
	}
	if (wantsSync) {
		try {
			await cli.restartDaemon();
		} catch {
			return {
				restoreDashboard: previousAuth.authenticated,
				requiresWizard: true,
				needsAttention: true,
			};
		}
	}
	return defaultFailedRecovery(previousAuth);
}

function defaultFailedRecovery(
	previousAuth: DesktopBootstrapState["auth"],
): FailedAuthenticationRecovery {
	return {
		restoreDashboard: previousAuth.authenticated,
		requiresWizard: !previousAuth.authenticated,
		needsAttention: false,
	};
}

function sameAccountState(
	left: DesktopBootstrapState["auth"],
	right: DesktopBootstrapState["auth"],
): boolean {
	return (
		left.authenticated === right.authenticated &&
		(left.user?.id ?? null) === (right.user?.id ?? null)
	);
}
