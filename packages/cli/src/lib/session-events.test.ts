import { describe, expect, test } from "bun:test";
import { projectEventsToMessages, sequenceSessionEvents } from "./session-events";

describe("visible session messages", () => {
	test.each([
		[["", "visible", ""], "visible"],
		[["first", "", "second"], "first\nsecond"],
		[["", ""], null],
		[[" "], " "],
	] as const)("filters empty text parts before joining %j", (texts, expected) => {
		const events = sequenceSessionEvents([
			{
				type: "message",
				role: "assistant",
				parts: texts.map((text) => ({ type: "text", text })),
				source: { adapter: "hermes", session_key: "fixture", record_id: "1" },
			},
		]);
		expect(projectEventsToMessages(events)).toEqual(
			expected === null ? [] : [{ role: "assistant", content: expected }],
		);
	});
});
