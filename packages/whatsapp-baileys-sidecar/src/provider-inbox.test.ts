import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DurableProviderInbox } from "./provider-inbox.js";

describe("durable provider inbox", () => {
	it("persists ordered Baileys proto events until acknowledged", () => {
		const directory = mkdtempSync(join(tmpdir(), "clawdi-wa-provider-inbox-"));
		const firstQueue = new DurableProviderInbox(directory);
		firstQueue.append({
			eventType: "messages.upsert",
			messageId: "message-1",
			remoteJid: "15551114444@s.whatsapp.net",
			fromMe: false,
			messageProtoBase64: "CgVoZWxsbw==",
		});
		firstQueue.append({
			eventType: "messages.upsert",
			messageId: "message-2",
			remoteJid: "120363000000000000@g.us",
			participant: "15551115555@s.whatsapp.net",
			fromMe: false,
			messageProtoBase64: "CgV3b3JsZA==",
		});

		const restartedQueue = new DurableProviderInbox(directory);
		expect(restartedQueue.list(100).map((event) => event.sequence)).toEqual([1, 2]);
		restartedQueue.acknowledge(1);
		expect(restartedQueue.list(100).map((event) => event.messageId)).toEqual(["message-2"]);
	});
});
