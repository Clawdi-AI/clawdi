import { expect, test } from "bun:test";
import {
	type ClawdiDesktopBridge,
	type DesktopDashboardSession,
	type DesktopWebSession,
	isClawdiDesktopBridge,
} from "@clawdi/shared/desktop";
import { restoreDesktopSession } from "./desktop-auth";

function bridge(
	createDashboardSession: ClawdiDesktopBridge["createDashboardSession"],
): ClawdiDesktopBridge {
	return {
		version: 1,
		openConnector: () => undefined,
		signOut: async () => undefined,
		createDashboardSession,
	};
}
const session: DesktopWebSession = { userId: "user_fixture", sessionId: "sess_fixture" };
const ticket: DesktopDashboardSession = {
	status: "ticket",
	accountId: session.userId,
	ticket: "fixture-ticket",
};
const noSignOut = async () => {
	throw new Error("Must not sign out");
};

test("normal browsers and incomplete capabilities cannot consume tickets", async () => {
	expect(isClawdiDesktopBridge({ version: 1, createDashboardSession: () => ticket })).toBe(false);
	expect(isClawdiDesktopBridge(bridge(async () => ticket))).toBe(true);
	await expect(
		restoreDesktopSession({
			bridge: null,
			session: null,
			signOut: noSignOut,
			consumeTicket: async () => {
				throw new Error("Must not consume");
			},
		}),
	).rejects.toThrow("Desktop");
});

test("valid same-account sessions are compared before minting or consuming a ticket", async () => {
	const requests: (DesktopWebSession | null)[] = [];
	const consumed: string[] = [];
	const desktop = bridge(async (current) => {
		requests.push(current ?? null);
		return current ? { status: "signed-in", accountId: session.userId } : ticket;
	});
	expect(
		await restoreDesktopSession({
			bridge: desktop,
			session,
			signOut: noSignOut,
			consumeTicket: async (value) => {
				consumed.push(value);
			},
		}),
	).toBe(false);
	expect(requests).toEqual([session]);
	expect(consumed).toEqual([]);
	expect(
		await restoreDesktopSession({
			bridge: desktop,
			session: null,
			signOut: noSignOut,
			consumeTicket: async (value) => {
				consumed.push(value);
			},
		}),
	).toBe(true);
	expect(consumed).toEqual(["fixture-ticket"]);
});

test("account mismatch revokes the previous session before requesting a ticket", async () => {
	const events: string[] = [];
	await restoreDesktopSession({
		bridge: bridge(async (current) => {
			events.push(current ? "compare" : "mint");
			return current ? { status: "sign-out", accountId: "user_fixture" } : ticket;
		}),
		session: { ...session, userId: "user_other" },
		signOut: async () => {
			events.push("revoke");
		},
		consumeTicket: async () => {
			events.push("consume");
		},
	});
	expect(events).toEqual(["compare", "revoke", "mint", "consume"]);
});

test("failed revocation does not mint, and expired or malformed tickets do not finish sign-in", async () => {
	await expect(
		restoreDesktopSession({
			bridge: bridge(async (current) => {
				if (!current) throw new Error("Must not mint");
				return { status: "sign-out", accountId: session.userId };
			}),
			session,
			signOut: async () => {
				throw new Error("revoke failed");
			},
			consumeTicket: async () => {},
		}),
	).rejects.toThrow("revoke failed");
	for (const value of ["", "x".repeat(8193)]) {
		await expect(
			restoreDesktopSession({
				bridge: bridge(async () => ({ ...ticket, status: "ticket", ticket: value })),
				session: null,
				signOut: noSignOut,
				consumeTicket: async () => {
					throw new Error("Must not consume");
				},
			}),
		).rejects.toThrow("Invalid Desktop session");
	}
	await expect(
		restoreDesktopSession({
			bridge: bridge(async () => ticket),
			session: null,
			signOut: noSignOut,
			consumeTicket: async () => {
				throw new Error("expired or used");
			},
		}),
	).rejects.toThrow("expired or used");
});
