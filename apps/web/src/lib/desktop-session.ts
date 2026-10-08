import type { ClawdiDashboardBridge } from "@clawdi/shared/desktop";

/** The preload bridge is the only ticket source. URL tickets are never read. */
export async function restoreDesktopSession(options: {
	bridge: ClawdiDashboardBridge | null;
	userId: string | null | undefined;
	legacyAccountId?: string | null;
	consumeTicket: (ticket: string) => Promise<void>;
}): Promise<void> {
	const bridge = options.bridge;
	if (!bridge) throw new Error("Open this page in Clawdi Desktop.");
	const result = await bridge.createDashboardSession();
	const ticket = typeof result === "string" ? result : result.ticket;
	const accountId = typeof result === "string" ? options.legacyAccountId : result.accountId;
	if (!accountId || !ticket || ticket.length > 8192) throw new Error("Invalid Desktop session.");
	if (options.userId) {
		if (options.userId !== accountId) throw new Error("Dashboard account mismatch.");
		return;
	}
	await options.consumeTicket(ticket);
}
