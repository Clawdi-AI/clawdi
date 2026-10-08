import { describe, expect, test } from "bun:test";
import type { DesktopBootstrapState, DesktopDetectedAgent } from "@clawdi/shared/desktop";
import {
	authenticateDesktopAccount,
	prepareDesktopStartup,
	reconcileDesktopStartupSync,
} from "./auth-orchestrator";

const AUTH_A = { authenticated: true, user: { id: "account-a" } } as const;

function state(
	auth: DesktopBootstrapState["auth"] = AUTH_A,
	daemon: DesktopBootstrapState["daemon"] = { installed: true, running: true },
): DesktopBootstrapState {
	return { platform: "darwin", cli: { status: "ready", version: "1.0.0" }, auth, daemon };
}

describe("Desktop sign-in", () => {
	test("reads the saved CLI state after authentication without changing sync", async () => {
		const calls: string[] = [];
		const authenticated = state(AUTH_A, { installed: true, running: false });
		const result = await authenticateDesktopAccount({
			authenticate: async () => {
				calls.push("authenticate");
				return { status: "authenticated", user: AUTH_A.user };
			},
			bootstrapState: async () => {
				calls.push("bootstrap");
				return authenticated;
			},
		});
		expect(calls).toEqual(["authenticate", "bootstrap"]);
		expect(result).toEqual({ status: "authenticated", state: authenticated });
	});

	test("cancel does not read state or mutate a pre-existing daemon", async () => {
		let reads = 0;
		expect(
			await authenticateDesktopAccount({
				authenticate: async () => ({ status: "cancelled" }),
				bootstrapState: async () => {
					reads += 1;
					return state();
				},
			}),
		).toEqual({ status: "cancelled" });
		expect(reads).toBe(0);
	});

	test("authentication and post-login state failures reach the existing error boundary", async () => {
		const cause = new Error("sign-in failed");
		await expect(
			authenticateDesktopAccount({
				authenticate: async () => {
					throw cause;
				},
				bootstrapState: async () => state(),
			}),
		).rejects.toBe(cause);
		await expect(
			authenticateDesktopAccount({
				authenticate: async () => ({ status: "authenticated", user: AUTH_A.user }),
				bootstrapState: async () => {
					throw cause;
				},
			}),
		).rejects.toBe(cause);
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
			reconcileDaemonRuntime: async () => {
				calls.push("reconcile");
				return false;
			},
			restartDaemon: async () => {
				calls.push("restart");
			},
		});
		expect(calls).toEqual(["bootstrap", "detect", "reconcile", "restart", "bootstrap"]);
		expect(result).toMatchObject({ needsAttention: false });
	});

	test("authenticated startup reads state before Agent inspection", async () => {
		const calls: string[] = [];
		const result = await prepareDesktopStartup({
			bootstrapState: async () => {
				calls.push("bootstrap");
				return state(AUTH_A, { installed: true, running: false });
			},
			detectAgents: async () => [],
			reconcileDaemonRuntime: async () => {
				calls.push("reconcile");
				return false;
			},
			restartDaemon: async () => {
				calls.push("restart");
			},
		});
		expect(calls).toEqual(["bootstrap"]);
		expect(result).toMatchObject({ requiresWizard: false });
	});

	test.each(["offline", "unverified"])(
		"%s Agent inspection never rebinds or restarts a daemon",
		async (inspection) => {
			const calls: string[] = [];
			const result = await reconcileDesktopStartupSync({
				bootstrapState: async () => {
					calls.push("bootstrap");
					return state(AUTH_A, { installed: true, running: false });
				},
				detectAgents: async () => {
					calls.push("detect");
					if (inspection === "offline") throw new Error("offline");
					return verified.map((agent) => ({ ...agent, inspection: "failed" as const }));
				},
				reconcileDaemonRuntime: async () => {
					calls.push("reconcile");
					return true;
				},
				restartDaemon: async () => {
					calls.push("restart");
				},
			});
			expect(calls).toEqual(["bootstrap", "detect"]);
			expect(result).toMatchObject({ needsAttention: true });
		},
	);
});
