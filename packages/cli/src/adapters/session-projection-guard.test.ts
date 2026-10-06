import { describe, expect, test } from "bun:test";
import { projectEventsToMessages, sequenceSessionEvents } from "../lib/session-events";
import {
	canonicalStructuredString,
	reasoningContent,
	toolResultContent,
	visibleContentParts,
} from "./rich-event-mapping";
import { assertProjectionGolden } from "./session-golden.test-support";

function richProjection() {
	const content = [
		{ type: "text", text: "Visible text" },
		{ type: "file", path: "/private/fixture/report.txt" },
		{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
		{ ok: true, signature: "hidden", nested: { reasoning: "hidden", count: 2 } },
	];
	return {
		visible: visibleContentParts(content),
		result: toolResultContent(content),
		reasoning: reasoningContent({
			type: "thinking",
			thinking: "Private reasoning",
			signature: "opaque",
		}),
		arguments: canonicalStructuredString('{"signature":"hidden","query":"fixture"}'),
		snapshot: projectEventsToMessages(
			sequenceSessionEvents([
				{
					type: "message",
					role: "assistant",
					parts: [
						{ type: "text", text: "" },
						{ type: "text", text: "Visible snapshot" },
					],
					source: { adapter: "hermes", session_key: "fixture", record_id: "1" },
				},
			]),
		),
	};
}

describe("session projection revision guard", () => {
	test("pins rich-event-mapping bytes to the shared projection revision", () => {
		assertProjectionGolden("rich-event-mapping", richProjection());
	});

	test("rejects changed projected bytes even if a golden fixture is updated", () => {
		expect(() =>
			assertProjectionGolden("rich-event-mapping", {
				...richProjection(),
				arguments: '{"query":"changed projection"}',
			}),
		).toThrow("bump SESSION_PROJECTION_REVISION");
	});
});
