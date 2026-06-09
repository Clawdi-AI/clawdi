import { describe, expect, it } from "bun:test";

import { decodeJsonBytes, encodeJsonBytes, parseBinaryNode } from "./json-bytes.js";

describe("json byte encoding", () => {
	it("round-trips byte content inside binary nodes", () => {
		const encoded = encodeJsonBytes({
			tag: "message",
			attrs: { to: "15551114444@s.whatsapp.net" },
			content: [{ tag: "enc", attrs: {}, content: Buffer.from([1, 2, 3]) }],
		});

		expect(encoded).toEqual({
			tag: "message",
			attrs: { to: "15551114444@s.whatsapp.net" },
			content: [
				{
					tag: "enc",
					attrs: {},
					content: { $type: "base64-bytes", base64: "AQID" },
				},
			],
		});

		const decoded = parseBinaryNode(decodeJsonBytes(encoded));
		expect(decoded.content).toEqual([{ tag: "enc", attrs: {}, content: Buffer.from([1, 2, 3]) }]);
	});

	it("rejects malformed byte sentinels", () => {
		expect(() => decodeJsonBytes({ $type: "base64-bytes", base64: 123 })).toThrow(
			"encoded byte sentinel requires base64 string",
		);
	});
});
