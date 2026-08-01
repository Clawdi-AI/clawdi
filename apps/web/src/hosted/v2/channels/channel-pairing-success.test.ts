import { describe, expect, test } from "bun:test";
import type { ChannelBinding } from "@/hosted/v2/channels/channel-types";
import {
	activeBindingsForPairingAttempt,
	firstNewActivePairingBinding,
	pairingSuccessDescription,
} from "./channel-pairing-success";

const existingBinding: ChannelBinding = {
	id: "binding-existing",
	account_id: "account-1",
	agent_link_id: "link-1",
	external_chat_id: "chat-existing",
	external_chat_type: "private",
	external_chat_name: "Existing chat",
	status: "active",
	created_at: "2026-08-01T00:00:00Z",
	last_message_at: null,
};

describe("pairing success detection", () => {
	test("finds only newly active bindings on the current account and link", () => {
		const newlyActive = { ...existingBinding, id: "binding-new", external_chat_id: "chat-new" };
		const inactive = { ...newlyActive, id: "binding-pending", status: "pending" };
		const otherLink = { ...newlyActive, id: "binding-other-link", agent_link_id: "link-2" };
		const otherAccount = { ...newlyActive, id: "binding-other-account", account_id: "account-2" };
		const active = activeBindingsForPairingAttempt(
			[existingBinding, inactive, otherLink, otherAccount, newlyActive],
			"account-1",
			"link-1",
		);

		expect(active.map((binding) => binding.id)).toEqual(["binding-existing", "binding-new"]);
		expect(firstNewActivePairingBinding(active, new Set(["binding-existing"]))?.id).toBe(
			"binding-new",
		);
	});

	test("does not treat pre-existing bindings or ordinary refetches as success", () => {
		const active = activeBindingsForPairingAttempt([existingBinding], "account-1", "link-1");
		const initialIds = new Set(active.map((binding) => binding.id));

		expect(firstNewActivePairingBinding(active, initialIds)).toBeNull();
		expect(firstNewActivePairingBinding([...active], initialIds)).toBeNull();
	});

	test("describes Telegram and Discord success with provider and scope", () => {
		expect(pairingSuccessDescription("telegram", existingBinding)).toBe(
			"Telegram private chat is ready.",
		);
		expect(
			pairingSuccessDescription("discord", {
				...existingBinding,
				external_chat_type: "guild",
			}),
		).toBe("Discord server is ready.");
		expect(pairingSuccessDescription("discord", existingBinding)).toBe(
			"Discord direct message is ready.",
		);
	});
});
