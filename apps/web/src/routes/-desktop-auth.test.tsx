import { expect, test } from "bun:test";
import type { ClawdiDesktopBridge } from "@clawdi/shared/desktop";
import { restoreDesktopSession } from "./desktop-auth";

function bridge(accountId = "user_fixture", ticket = "fixture-ticket"): ClawdiDesktopBridge {
	return {
		version: 1,
		openConnector: () => undefined,
		openInBrowser: () => undefined,
		signOut: async () => undefined,
		createDashboardSession: async () => ({ accountId, ticket }),
	};
}

test("a normal browser cannot consume a URL ticket without the preload", async () => {
	let consumed = false;
	await expect(
		restoreDesktopSession({
			bridge: null,
			userId: null,
			consumeTicket: async () => {
				consumed = true;
			},
		}),
	).rejects.toThrow("Desktop");
	expect(consumed).toBe(false);
});

test("only the preload ticket is consumed and same-account sessions are reused", async () => {
	const tickets: string[] = [];
	const consumeTicket = async (ticket: string) => {
		tickets.push(ticket);
	};
	await restoreDesktopSession({ bridge: bridge(), userId: null, consumeTicket });
	expect(tickets).toEqual(["fixture-ticket"]);
	await restoreDesktopSession({ bridge: bridge(), userId: "user_fixture", consumeTicket });
	expect(tickets).toHaveLength(1);
	await expect(
		restoreDesktopSession({ bridge: bridge(), userId: "another_user", consumeTicket }),
	).rejects.toThrow("mismatch");
	expect(tickets).toHaveLength(1);
});

test("expired, reused or malformed tickets fail without navigating to the dashboard", async () => {
	await expect(
		restoreDesktopSession({
			bridge: bridge(),
			userId: null,
			consumeTicket: async () => {
				throw new Error("expired or already used");
			},
		}),
	).rejects.toThrow("expired or already used");
	for (const value of [
		bridge("", "fixture"),
		bridge("user_fixture", ""),
		bridge("user_fixture", "x".repeat(8193)),
	]) {
		await expect(
			restoreDesktopSession({
				bridge: value,
				userId: null,
				consumeTicket: async () => {
					throw new Error("must not consume");
				},
			}),
		).rejects.toThrow("Invalid Desktop session");
	}
});
