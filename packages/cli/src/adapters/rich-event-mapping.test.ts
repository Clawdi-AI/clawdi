import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	completeJsonlRecords,
	reasoningContent,
	toolResultContent,
	visibleContentParts,
} from "./rich-event-mapping";

describe("rich event mapping", () => {
	test("keeps complete JSONL records without a trailing newline and ignores a partial tail", () => {
		const records = completeJsonlRecords('{"id":"first"}\n{"partial":\n{"id":"last"}');
		expect(records).toEqual([
			{ data: { id: "first" }, recordSeq: 0 },
			{ data: { id: "last" }, recordSeq: 2 },
		]);
		expect(completeJsonlRecords('{"id":"first"}\n{"partial":')).toEqual([
			{ data: { id: "first" }, recordSeq: 0 },
		]);
	});

	test("keeps safe attachment references and degrades inline/local content to metadata", () => {
		const inlineBytes = Buffer.from("inline image bytes");
		const inlineData = inlineBytes.toString("base64");
		const parts = visibleContentParts([
			{
				type: "file",
				id: "provider-file-1",
				url: "https://cdn.example.com/files/report.pdf",
				name: "report.pdf",
				media_type: "application/pdf",
			},
			{ type: "image", data: inlineData, mimeType: "image/png" },
			{ type: "file", path: "/Users/alice/private/client-notes.txt" },
		]);

		expect(parts[0]).toMatchObject({
			type: "attachment",
			availability: "external",
			uri: "https://cdn.example.com/files/report.pdf",
			name: "report.pdf",
			media_type: "application/pdf",
		});
		expect(parts[1]).toMatchObject({
			type: "attachment",
			availability: "metadata_only",
			size_bytes: inlineBytes.length,
			sha256: createHash("sha256").update(inlineBytes).digest("hex"),
		});
		expect(parts[2]).toMatchObject({
			type: "attachment",
			availability: "metadata_only",
			name: "client-notes.txt",
		});
		const serialized = JSON.stringify(parts);
		expect(serialized).not.toContain(inlineData);
		expect(serialized).not.toContain("/Users/alice/private");
	});

	test("separates visible text from canonical structured tool output", () => {
		const mapped = toolResultContent([
			{ type: "text", text: "visible result" },
			{
				ok: true,
				items: [{ id: 1 }],
				password: "domain password value",
				api_key: "tool-returned key",
				authorization: "tool-returned authorization",
				encrypted_business_value: "durable ciphertext",
				reasoning: "hidden reasoning",
				encrypted_content: "opaque continuation",
			},
		]);

		expect(mapped.parts).toEqual([{ type: "text", text: "visible result" }]);
		expect(mapped.result_json).toBe(
			'[{"api_key":"tool-returned key","authorization":"tool-returned authorization","encrypted_business_value":"durable ciphertext","items":[{"id":1}],"ok":true,"password":"domain password value"}]',
		);
		expect(JSON.stringify(mapped)).not.toContain("hidden reasoning");
		expect(JSON.stringify(mapped)).not.toContain("opaque continuation");
	});

	test("maps reasoning text and provider continuation without retaining its source envelope", () => {
		const mapped = reasoningContent({
			type: "reasoning",
			summary: [{ type: "summary_text", text: "private reasoning" }],
			signature: "signed-state",
			encrypted_content: "opaque continuation",
			provider_envelope: { duplicate_visible_message: "do not retain" },
		});

		expect(mapped).toEqual({
			kind: "reasoning",
			parts: [{ type: "text", text: "private reasoning" }],
			payload_json: '{"encrypted_content":"opaque continuation","signature":"signed-state"}',
		});
		expect(JSON.stringify(mapped)).not.toContain("duplicate_visible_message");
	});
});
