import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionTimelineList } from "@/components/sessions/message-list";
import type { SessionTimelineItem } from "@/lib/api-schemas";

const timestamp = "2026-08-29T10:00:00.000Z";

function render(items: SessionTimelineItem[]) {
	return renderToStaticMarkup(
		createElement(SessionTimelineList, {
			items,
			agentType: "codex",
			userName: "You",
		}),
	);
}

describe("SessionTimelineList", () => {
	test("pairs parallel tool calls with results by call ID", () => {
		const markup = render([
			{
				kind: "tool_call",
				position: 1,
				call_id: "call-read",
				name: "read",
				arguments_json: '{"path":"README.md"}',
				timestamp,
			},
			{
				kind: "tool_call",
				position: 2,
				call_id: "call-search",
				name: "search",
				arguments_json: '{"query":"session"}',
				timestamp,
			},
			{
				kind: "tool_result",
				position: 3,
				call_id: "call-read",
				name: "read",
				status: "completed",
				content: "README contents",
				timestamp,
			},
			{
				kind: "tool_result",
				position: 4,
				call_id: "call-search",
				name: "search",
				status: "error",
				content: "Search failed",
				timestamp,
			},
		]);

		expect(markup.match(/<button/g)).toHaveLength(2);
		expect(markup.match(/Done/g)).toHaveLength(1);
		expect(markup.match(/Error/g)).toHaveLength(1);
	});

	test("starts a new assistant group when the model changes", () => {
		const markup = render([
			{
				kind: "message",
				position: 1,
				role: "assistant",
				content: "First response",
				model: "gpt-5",
				timestamp,
			},
			{
				kind: "message",
				position: 2,
				role: "assistant",
				content: "Second response",
				model: "claude-sonnet-4-5",
				timestamp,
			},
		]);

		expect(markup).toContain("GPT 5");
		expect(markup).toContain("Sonnet 4.5");
	});
});
