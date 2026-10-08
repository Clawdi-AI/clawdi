import { expect, test } from "bun:test";
import type { ClawdiDesktopBridge } from "@clawdi/shared/desktop";
import { restoreDesktopSession } from "./desktop-session";

function bridge(ticket = "one-use-ticket", accountId = "user-local"): ClawdiDesktopBridge {
	return {
		apiVersion: 2,
		async createDashboardSession() {
			return { ticket, accountId };
		},
		async signOut() {},
		async openConnectWizard() {},
		async openExternal() {},
	};
}

test("normal browsers cannot hand off a ticket", async () => {
	let consumed = false;
	await expect(
		restoreDesktopSession({
			bridge: null,
			userId: null,
			consumeTicket: async () => {
				consumed = true;
			},
		}),
	).rejects.toThrow("Clawdi Desktop");
	expect(consumed).toBe(false);
});

test("ticket comes only from the preload and is consumed once", async () => {
	let consumed = 0;
	const consumeTicket = async (ticket: string) => {
		expect(ticket).toBe("one-use-ticket");
		if (consumed++) throw new Error("Already consumed");
	};
	const options = { bridge: bridge(), userId: null, consumeTicket };
	await restoreDesktopSession(options);
	await expect(restoreDesktopSession(options)).rejects.toThrow("Already consumed");
});

test("existing account must match local account and invalid tickets fail closed", async () => {
	let consumed = false;
	const consumeTicket = async () => {
		consumed = true;
	};
	await restoreDesktopSession({ bridge: bridge(), userId: "user-local", consumeTicket });
	await expect(
		restoreDesktopSession({ bridge: bridge(), userId: "user-other", consumeTicket }),
	).rejects.toThrow("mismatch");
	for (const ticket of ["", "x".repeat(8193)]) {
		await expect(
			restoreDesktopSession({ bridge: bridge(ticket), userId: null, consumeTicket }),
		).rejects.toThrow("Invalid");
	}
	expect(consumed).toBe(false);
});
