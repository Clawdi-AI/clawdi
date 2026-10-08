import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import inlineImage from "../../tests/fixtures/hermes-inline-image.json";
import {
	advanceEventHead,
	EMPTY_EVENT_HEAD,
	encodeEventNdjson,
	sequenceSessionEvents,
} from "../lib/session-events";
import { reasoningContent, toolResultContent, visibleContentParts } from "./rich-event-mapping";

// Released in-bounds projection: canonical NDJSON and chained head.
const RELEASED_ATTACHMENT_EVENT =
	'{"event_id":"ddfd722637fd1417656e5745ae020136536de65dc24127eb644a4d1d1f30121d","parts":[{"attachment_id":"sha256:c545ca7c26e89305e145034fe23d91362f4cb12e9ed21056a13294efbcc009e9","availability":"external","media_type":"application/pdf","name":"report.pdf","size_bytes":42,"type":"attachment","uri":"https://cdn.example.com/report.pdf"}],"role":"user","seq":0,"source":{"adapter":"codex","record_id":"file-1","session_key":"fixture"},"type":"message"}\n';
const RELEASED_ATTACHMENT_HEAD = "ff1a3533d69d41a09d92e7e61518d550ef1e5951d62a0ed8950d9cdbf3ca3c69";

describe("rich event mapping", () => {
	test.each([
		["ASCII", "a".repeat(513), `${"a".repeat(511)}…`],
		["ASCII with extension", `${"a".repeat(600)}.pdf`, `${"a".repeat(507)}….pdf`],
		["multi-byte", "文".repeat(600), `${"文".repeat(511)}…`],
		["multi-byte with extension", `${"文".repeat(600)}.txt`, `${"文".repeat(507)}….txt`],
		["emoji", "😀".repeat(600), `${"😀".repeat(511)}…`],
		["emoji with extension", `${"😀".repeat(600)}.png`, `${"😀".repeat(507)}….png`],
		[
			"short extension boundary",
			`${"a".repeat(600)}.${"x".repeat(15)}`,
			`${"a".repeat(495)}….${"x".repeat(15)}`,
		],
		["long extension", `${"a".repeat(600)}.${"x".repeat(16)}`, `${"a".repeat(511)}…`],
		["dotfile", `.${"a".repeat(600)}`, `.${"a".repeat(510)}…`],
	] as const)("bounds %s attachment names by Unicode code points", (_label, name, expected) => {
		const input = { type: "file", id: "long-name", name };
		const parts = visibleContentParts(input);
		expect(parts).toEqual([
			{
				type: "attachment",
				attachment_id: `sha256:${createHash("sha256").update(input.id).digest("hex")}`,
				availability: "metadata_only",
				name: expected,
			},
		]);
		expect(Array.from(expected)).toHaveLength(512);
		expect(expected).not.toMatch(
			/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
		);
		expect(JSON.stringify(visibleContentParts(input))).toBe(JSON.stringify(parts));
	});

	test.each(["name", "filename", "path", "url"] as const)(
		"bounds names inferred from %s without changing attachment identity",
		(field) => {
			const name = `${"n".repeat(600)}.pdf`;
			const value =
				field === "path"
					? `/private/${name}`
					: field === "url"
						? `https://cdn.example.com/${name}`
						: name;
			const identity =
				field === "path" || field === "url"
					? value
					: '{"media_type":null,"name":null,"size_bytes":null}';
			expect(visibleContentParts({ type: "file", [field]: value })[0]).toMatchObject({
				attachment_id: `sha256:${createHash("sha256").update(identity).digest("hex")}`,
				name: `${"n".repeat(507)}….pdf`,
			});
		},
	);

	test("keeps the released identity fallback when a long name precedes a short filename", () => {
		expect(
			visibleContentParts({ type: "file", name: "a".repeat(600), filename: "old.pdf" })[0],
		).toMatchObject({
			attachment_id: `sha256:${createHash("sha256").update('{"media_type":null,"name":"old.pdf","size_bytes":null}').digest("hex")}`,
			name: `${"a".repeat(511)}…`,
		});
	});

	test.each(["x".repeat(256), "文".repeat(256), "😀".repeat(256)])(
		"omits over-long media types without changing their identity hash",
		(mediaType) => {
			const parts = visibleContentParts({
				type: "file",
				media_type: mediaType,
				name: "report.pdf",
			});
			const identity = JSON.stringify({
				media_type: mediaType,
				name: "report.pdf",
				size_bytes: null,
			});
			// Identity uses canonical ASCII JSON, including escaped Unicode.
			const canonicalIdentity = identity.replace(
				/[^\x20-\x7e]/g,
				(character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
			);
			expect(parts).toEqual([
				{
					type: "attachment",
					attachment_id: `sha256:${createHash("sha256").update(canonicalIdentity).digest("hex")}`,
					availability: "metadata_only",
					name: "report.pdf",
				},
			]);
		},
	);

	test.each(["x", "文", "😀"])(
		"degrades over-long %s URIs to metadata with intact content identity",
		(character) => {
			const prefix = "https://cdn.example.com/";
			const uri = prefix + character.repeat(4097 - prefix.length);
			const sha = "a".repeat(64);
			expect(
				visibleContentParts({ type: "file", uri, name: "report.pdf", size: 42, sha256: sha }),
			).toEqual([
				{
					type: "attachment",
					attachment_id: `sha256:${createHash("sha256").update(`content:${sha}`).digest("hex")}`,
					availability: "metadata_only",
					name: "report.pdf",
					size_bytes: 42,
					sha256: sha,
				},
			]);
		},
	);

	test("keeps in-bounds fields and the released UTF-16 name omission byte-identical", () => {
		const uriPrefix = "https://cdn.example.com/";
		for (const name of ["a".repeat(512), "文".repeat(512), "😀".repeat(256), "😀".repeat(512)]) {
			const input = {
				type: "file",
				id: "in-bounds",
				uri: uriPrefix + "x".repeat(4096 - uriPrefix.length),
				name,
				media_type: "😀".repeat(255),
				size: 42,
				sha256: "a".repeat(64),
			};
			const released = [
				{
					type: "attachment",
					attachment_id: `sha256:${createHash("sha256").update(input.id).digest("hex")}`,
					availability: "external",
					uri: input.uri,
					...(name.length <= 512 ? { name } : {}),
					media_type: input.media_type,
					size_bytes: 42,
					sha256: input.sha256,
				},
			];
			expect(JSON.stringify(visibleContentParts(input))).toBe(JSON.stringify(released));
		}
	});

	test("keeps in-bounds event bytes and the chained head equal to the released golden", () => {
		const events = sequenceSessionEvents([
			{
				type: "message",
				role: "user",
				source: { adapter: "codex", session_key: "fixture", record_id: "file-1" },
				parts: visibleContentParts({
					type: "file",
					name: "report.pdf",
					media_type: "application/pdf",
					url: "https://cdn.example.com/report.pdf",
					size: 42,
				}),
			},
		]);
		// Captured from the released projection; pin both canonical event bytes and head.
		expect(encodeEventNdjson(events).toString("ascii")).toBe(RELEASED_ATTACHMENT_EVENT);
		expect(advanceEventHead(EMPTY_EVENT_HEAD, events)).toBe(RELEASED_ATTACHMENT_HEAD);
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

	test("maps inline image URLs without treating their payload as an attachment name", () => {
		const result = toolResultContent(inlineImage.content);
		expect(result.parts).toEqual([
			{ type: "text", text: "Synthetic image input" },
			{
				type: "attachment",
				attachment_id: `sha256:${createHash("sha256")
					.update(inlineImage.content[1]?.image_url?.url ?? "")
					.digest("hex")}`,
				availability: "metadata_only",
			},
		]);
		expect(JSON.stringify(result)).not.toContain("base64");
		const attachments = [...result.parts, ...visibleContentParts(inlineImage.content)].filter(
			(part) => part.type === "attachment",
		);
		expect(attachments).toHaveLength(2);
		for (const attachment of attachments) {
			expect(attachment.name ?? null).toBeNull();
		}
		expect(
			visibleContentParts({ type: "file", url: "https://cdn.example.com/report%20one.pdf" })[0],
		).toMatchObject({ name: "report one.pdf" });
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
