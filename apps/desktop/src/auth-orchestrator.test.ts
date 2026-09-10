import { describe, expect, test } from "bun:test";
import type { DesktopBootstrapState, DesktopDetectedAgent } from "@clawdi/shared/desktop";
import {
	authenticateDesktopAccount,
	DesktopAuthenticationTransitionError,
	prepareDesktopStartup,
	reconcileDesktopStartupSync,
} from "./auth-orchestrator";

const AUTH_A = { authenticated: true, user: { id: "account-a" } } as const;
const AUTH_B = { authenticated: true, user: { id: "account-b" } } as const;

function state(
	auth: DesktopBootstrapState["auth"] = AUTH_A,
	daemon: DesktopBootstrapState["daemon"] = { installed: true, running: true },
): DesktopBootstrapState {
	return { platform: "darwin", cli: { status: "ready", version: "1.0.0" }, auth, daemon };
}

function authPort(options: {
	preflight?: DesktopBootstrapState;
	result?: { status: "authenticated"; user: { id: string } } | { status: "cancelled" };
	restartFails?: boolean;
	stopFails?: boolean;
}) {
	const calls: string[] = [];
	const preflight = options.preflight ?? state();
	return {
		calls,
		port: {
			bootstrapState: async () => {
				calls.push("bootstrap");
				return preflight;
			},
			getAuthState: async () => {
				calls.push("auth-state");
				return preflight.auth;
			},
			authenticate: async () => {
				calls.push("oauth");
				return options.result ?? { status: "authenticated" as const, user: { id: "account-a" } };
			},
			stopDaemon: async () => {
				calls.push("stop");
				if (options.stopFails) throw new Error("stop failed");
			},
			restartDaemon: async () => {
				calls.push("restart");
				if (options.restartFails) throw new Error("restart failed");
			},
		},
	};
}

describe("Desktop auth transition", () => {
	test("same-account force sign-in stops before OAuth and restores installed sync intent", async () => {
		const { port, calls } = authPort({});
		const result = await authenticateDesktopAccount(port, {
			force: true,
			beforeAuthentication: async () => {
				calls.push("suspend-dashboard");
			},
		});
		expect(calls).toEqual(["bootstrap", "stop", "suspend-dashboard", "oauth", "restart"]);
		expect(result).toEqual({
			status: "authenticated",
			accountChanged: false,
			requiresWizard: false,
			needsAttention: false,
		});
	});

	test("installed=false force sign-in never mutates daemon state", async () => {
		const { port, calls } = authPort({
			preflight: state(AUTH_A, { installed: false, running: false }),
		});
		await authenticateDesktopAccount(port, { force: true });
		expect(calls).toEqual(["bootstrap", "oauth"]);
	});

	test("first sign-in never restarts an unowned pre-existing unit", async () => {
		const { port, calls } = authPort({
			preflight: state({ authenticated: false, user: null }, { installed: true, running: false }),
		});
		await authenticateDesktopAccount(port);
		expect(calls).toEqual(["bootstrap", "oauth"]);
	});

	test("cross-account force sign-in enters Wizard without restarting the old unit", async () => {
		const { port, calls } = authPort({
			result: { status: "authenticated", user: { id: AUTH_B.user.id } },
		});
		const result = await authenticateDesktopAccount(port, { force: true });
		expect(calls).toEqual(["bootstrap", "stop", "oauth"]);
		expect(result).toMatchObject({
			status: "authenticated",
			accountChanged: true,
			requiresWizard: true,
		});
	});

	test("cancel restores the old installed daemon, while stop failure never starts OAuth", async () => {
		const cancelled = authPort({ result: { status: "cancelled" } });
		const result = await authenticateDesktopAccount(cancelled.port, { force: true });
		expect(cancelled.calls).toEqual(["bootstrap", "stop", "oauth", "auth-state", "restart"]);
		expect(result).toMatchObject({ status: "cancelled", restoreDashboard: true });

		const failedStop = authPort({ stopFails: true });
		await expect(authenticateDesktopAccount(failedStop.port, { force: true })).rejects.toThrow(
			"stop failed",
		);
		expect(failedStop.calls).toEqual(["bootstrap", "stop"]);
	});

	test("failed compensation is explicit and requires Wizard recovery", async () => {
		const { port } = authPort({ restartFails: true, result: { status: "cancelled" } });
		const result = await authenticateDesktopAccount(port, { force: true });
		expect(result).toMatchObject({
			status: "cancelled",
			restoreDashboard: true,
			requiresWizard: true,
			needsAttention: true,
		});
	});

	test("OAuth failure exposes compensation state without losing the original cause", async () => {
		const { port } = authPort({});
		port.authenticate = async () => {
			throw new Error("oauth failed");
		};
		try {
			await authenticateDesktopAccount(port, { force: true });
			throw new Error("expected auth transition failure");
		} catch (error) {
			expect(error).toBeInstanceOf(DesktopAuthenticationTransitionError);
			expect((error as DesktopAuthenticationTransitionError).recovery).toEqual({
				restoreDashboard: true,
				requiresWizard: false,
				needsAttention: false,
			});
			expect((error as Error).cause).toBeInstanceOf(Error);
		}
	});

	test("dashboard suspension failure restores the stopped daemon before surfacing", async () => {
		const { port, calls } = authPort({});
		await expect(
			authenticateDesktopAccount(port, {
				force: true,
				beforeAuthentication: async () => {
					calls.push("suspend-dashboard");
					throw new Error("session clear failed");
				},
			}),
		).rejects.toBeInstanceOf(DesktopAuthenticationTransitionError);
		expect(calls).toEqual(["bootstrap", "stop", "suspend-dashboard", "auth-state", "restart"]);
	});
});

describe("Desktop startup recovery", () => {
	const verified: DesktopDetectedAgent[] = [
		{
			type: "codex",
			displayName: "Codex",
			detected: true,
			registered: true,
			version: "1.0.0",
			inspection: "complete",
		},
	];

	test("cold-restores an installed unit only after a verified registration", async () => {
		const calls: string[] = [];
		const result = await reconcileDesktopStartupSync({
			bootstrapState: async () => {
				calls.push("bootstrap");
				return state(AUTH_A, { installed: true, running: calls.includes("restart") });
			},
			detectAgents: async () => {
				calls.push("detect");
				return verified;
			},
			restartDaemon: async () => {
				calls.push("restart");
			},
		});
		expect(calls).toEqual(["bootstrap", "detect", "restart", "bootstrap"]);
		expect(result).toMatchObject({ needsAttention: false });
	});

	test("authenticated startup opens Dashboard before Agent inspection", async () => {
		const calls: string[] = [];
		const result = await prepareDesktopStartup({
			bootstrapState: async () => {
				calls.push("bootstrap");
				return state(AUTH_A, { installed: true, running: false });
			},
			detectAgents: async () => [],
			restartDaemon: async () => {
				calls.push("restart");
			},
		});
		expect(calls).toEqual(["bootstrap"]);
		expect(result).toMatchObject({ requiresWizard: false });
	});

	test("transient Agent inspection failure does not restart or require onboarding", async () => {
		const calls: string[] = [];
		const result = await reconcileDesktopStartupSync({
			bootstrapState: async () => {
				calls.push("bootstrap");
				return state(AUTH_A, { installed: true, running: false });
			},
			detectAgents: async () => {
				calls.push("detect");
				throw new Error("offline");
			},
			restartDaemon: async () => {
				calls.push("restart");
			},
		});
		expect(calls).toEqual(["bootstrap", "detect"]);
		expect(result).toMatchObject({ needsAttention: true });
	});
});
