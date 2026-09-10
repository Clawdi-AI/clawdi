import { expect, mock, test } from "bun:test";
import { restoreDesktopSession } from "./desktop-session";

test("reopening with a matching Clerk session does not request or consume a ticket", async () => {
	const createTicket = mock(async () => "ticket");
	const consumeTicket = mock(async () => {});
	await restoreDesktopSession({
		userId: "account-a",
		accountId: "account-a",
		createTicket,
		consumeTicket,
	});
	expect(createTicket).not.toHaveBeenCalled();
	expect(consumeTicket).not.toHaveBeenCalled();
});

test("expired Clerk session requests exactly one replacement ticket", async () => {
	const createTicket = mock(async () => "ticket");
	const consumeTicket = mock(async () => {});
	await restoreDesktopSession({
		userId: null,
		accountId: "account-a",
		createTicket,
		consumeTicket,
	});
	expect(createTicket).toHaveBeenCalledTimes(1);
	expect(consumeTicket).toHaveBeenCalledWith("ticket");
});

test("a different account fails closed without minting a ticket", async () => {
	const createTicket = mock(async () => "ticket");
	const consumeTicket = mock(async () => {});
	await expect(
		restoreDesktopSession({
			userId: "account-b",
			accountId: "account-a",
			createTicket,
			consumeTicket,
		}),
	).rejects.toThrow("mismatch");
	expect(createTicket).not.toHaveBeenCalled();
});
