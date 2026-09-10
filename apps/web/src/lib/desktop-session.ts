/** Restore Clerk before requesting a new one-use ticket from the local account. */
export async function restoreDesktopSession(options: {
	userId: string | null | undefined;
	accountId: string | null;
	createTicket: () => Promise<string>;
	consumeTicket: (ticket: string) => Promise<void>;
}): Promise<void> {
	if (!options.accountId) throw new Error("Missing local account.");
	if (options.userId) {
		if (options.userId !== options.accountId) throw new Error("Dashboard account mismatch.");
		return;
	}
	const ticket = await options.createTicket();
	if (!ticket || ticket.length > 8192) throw new Error("Invalid sign-in ticket.");
	await options.consumeTicket(ticket);
}
