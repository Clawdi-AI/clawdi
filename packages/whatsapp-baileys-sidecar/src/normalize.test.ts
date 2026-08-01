import { describe, expect, it } from "bun:test";
import type { WAMessage } from "baileys";

import { normalizeActorAliases, normalizeChatAliases, providerEventId } from "./jid.js";
import { normalizeInboundMessage } from "./normalize.js";

describe("WhatsApp callback normalization", () => {
	it("keeps provider identity invariant when explicit PN/LID primary and alt swap", () => {
		const first = providerEventId({
			accountId: "account-a",
			messageId: "M1",
			chat: normalizeChatAliases("15550001111@s.whatsapp.net", "123456789@lid"),
			actor: normalizeActorAliases("15550002222@s.whatsapp.net", "987654321@lid"),
		});
		const swapped = providerEventId({
			accountId: "account-a",
			messageId: "M1",
			chat: normalizeChatAliases("123456789@lid", "15550001111@s.whatsapp.net"),
			actor: normalizeActorAliases("987654321@lid", "15550002222@s.whatsapp.net"),
		});
		expect(swapped).toBe(first);
	});

	it("never infers PN from LID and rejects alias conflicts and group chat alternates", () => {
		expect(normalizeChatAliases("123456789@lid")).toEqual({ primary: "123456789@lid" });
		expect(() =>
			normalizeChatAliases("15550001111@s.whatsapp.net", "15550002222@s.whatsapp.net"),
		).toThrow("must_be_pn_and_lid");
		expect(() =>
			normalizeChatAliases("120363000000001@g.us", "15550001111@s.whatsapp.net"),
		).toThrow("group_chat_alt_not_allowed");
	});

	it("keeps a group chat as @g.us and carries PN/LID aliases only on the actor", () => {
		const event = normalizeInboundMessage(
			message({
				remoteJid: "120363000000001@g.us",
				participant: "15550001111@s.whatsapp.net",
				participantAlt: "123456789@lid",
			}),
			"account-a",
		);
		expect(event?.chat).toEqual({ primary: "120363000000001@g.us" });
		expect(event?.actor).toEqual({
			primary: "15550001111@s.whatsapp.net",
			alt: "123456789@lid",
		});
	});

	it("rejects hosted/global ingress and emits bounded explicit unknown content", () => {
		expect(
			normalizeInboundMessage(message({ remoteJid: "15550001111@hosted" }), "account-a"),
		).toBeNull();
		expect(
			normalizeInboundMessage(message({ remoteJid: "status@broadcast" }), "account-a"),
		).toBeNull();
		const unknown = message({ remoteJid: "15550001111@s.whatsapp.net" });
		unknown.message = { contactMessage: { displayName: "name", vcard: "BEGIN:VCARD" } };
		expect(normalizeInboundMessage(unknown, "account-a")?.content).toEqual({
			type: "unknown",
			providerContentType: "contactMessage",
		});
	});

	it("exposes only opaque media identity and bounded metadata", () => {
		const media = message({ remoteJid: "15550001111@s.whatsapp.net" });
		media.message = {
			imageMessage: {
				mediaKey: Buffer.from([1, 2, 3]),
				directPath: "/secret",
				mimetype: "image/jpeg",
				fileLength: 10,
				caption: "caption",
			},
		};
		const content = normalizeInboundMessage(media, "account-a")?.content;
		expect(content).toMatchObject({
			type: "media",
			mediaType: "image",
			mimeType: "image/jpeg",
			fileLength: 10,
			caption: "caption",
		});
		expect(JSON.stringify(content)).not.toContain("secret");
		expect(JSON.stringify(content)).not.toContain("AQID");
	});

	it("preserves the provider voice-note marker without exposing provider media secrets", () => {
		const voice = message({ remoteJid: "15550001111@s.whatsapp.net" });
		voice.message = {
			audioMessage: {
				mediaKey: Buffer.from([4, 5, 6]),
				directPath: "/voice-secret",
				mimetype: "audio/ogg; codecs=opus",
				ptt: true,
			},
		};
		const content = normalizeInboundMessage(voice, "account-a")?.content;
		expect(content).toMatchObject({
			type: "media",
			mediaType: "audio",
			ptt: true,
		});
		expect(JSON.stringify(content)).not.toContain("voice-secret");
		expect(JSON.stringify(content)).not.toContain("BAUG");
	});
});

function message(key: Partial<WAMessage["key"]>): WAMessage {
	return {
		key: { id: "M1", fromMe: false, ...key },
		message: { conversation: "hello" },
		messageTimestamp: 123,
	};
}
