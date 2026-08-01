import { describe, expect, it } from "bun:test";
import type { WAMessage } from "baileys";

import { normalizeInboundMessage } from "./normalize.js";

describe("Baileys sidecar event normalization", () => {
	it("keeps group routing on the group JID and actor identity on the participant", () => {
		const message: WAMessage = {
			key: {
				id: "BAILEYS-INBOUND-1",
				remoteJid: "120363012345678901@g.us",
				remoteJidAlt: "120363012345678901@g.us",
				participant: "15551114444@s.whatsapp.net",
				participantAlt: "7826185388106@lid",
				fromMe: false,
			},
			message: { extendedTextMessage: { text: "hello group" } },
			pushName: "Alice",
			messageTimestamp: 1_700_000_000,
		};

		const event = normalizeInboundMessage(message, {
			upsertType: "notify",
			requestId: "request-1",
		});

		expect(event).toEqual({
			schemaVersion: "clawdi.whatsapp.sidecar-event.v1",
			providerEventId: "message:BAILEYS-INBOUND-1",
			messageId: "BAILEYS-INBOUND-1",
			chatJid: "120363012345678901@g.us",
			actorJid: "15551114444@s.whatsapp.net",
			actorJidAlt: "7826185388106@lid",
			text: "hello group",
			pushName: "Alice",
			timestamp: 1_700_000_000,
			fromMe: false,
		});
	});

	it("ignores messages sent by the physical account", () => {
		const message: WAMessage = {
			key: {
				id: "OUTBOUND-1",
				remoteJid: "15551114444@s.whatsapp.net",
				fromMe: true,
			},
			message: { conversation: "echo" },
		};

		expect(normalizeInboundMessage(message, { upsertType: "notify" })).toBeNull();
	});

	it("preserves inbound content whitespace and newlines exactly", () => {
		const text = "  hello\nworld\t ";
		const event = normalizeInboundMessage(
			{
				key: {
					id: "WHITESPACE-1",
					remoteJid: "15551114444@s.whatsapp.net",
					fromMe: false,
				},
				message: { conversation: text },
			},
			{ upsertType: "notify" },
		);

		expect(event?.text).toBe(text);
	});

	it("ignores history, replacements, unsupported entities, and media without text", () => {
		const dm = {
			key: {
				id: "IGNORED",
				remoteJid: "15551114444@s.whatsapp.net",
				fromMe: false,
			},
			message: { conversation: "old" },
		} satisfies WAMessage;
		expect(normalizeInboundMessage(dm, { upsertType: "append" })).toBeNull();
		expect(normalizeInboundMessage(dm, { upsertType: "replace" })).toBeNull();
		expect(
			normalizeInboundMessage(
				{ ...dm, key: { ...dm.key, remoteJid: "status@broadcast" } },
				{ upsertType: "notify" },
			),
		).toBeNull();
		expect(
			normalizeInboundMessage(
				{ ...dm, key: { ...dm.key, remoteJid: "12345@newsletter" } },
				{ upsertType: "notify" },
			),
		).toBeNull();
		expect(
			normalizeInboundMessage(
				{ ...dm, key: { ...dm.key, remoteJid: "15551114444@c.us" } },
				{ upsertType: "notify" },
			),
		).toBeNull();
		expect(
			normalizeInboundMessage(
				{ ...dm, message: { imageMessage: { url: "https://media.invalid" } } },
				{ upsertType: "notify" },
			),
		).toBeNull();
	});
});
