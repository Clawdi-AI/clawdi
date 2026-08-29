import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionTimelineList } from "@/components/sessions/message-list";
import type { SessionTimelineItem } from "@/lib/api-schemas";

const timestamp = "2026-08-29T10:00:00.000Z";

function render(
	items: SessionTimelineItem[],
	options: {
		itemKeys?: string[];
		highlightedMessageKey?: string;
		highlightQuery?: string;
	} = {},
) {
	return renderToStaticMarkup(
		createElement(SessionTimelineList, {
			items,
			agentType: "codex",
			userName: "You",
			...options,
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

	test("preserves repeated tool calls that reuse a call ID", () => {
		const markup = render([
			{
				kind: "tool_call",
				position: 1,
				call_id: "reused-call",
				name: "first-attempt",
				arguments_json: '{"attempt":1}',
				timestamp,
			},
			{
				kind: "tool_call",
				position: 2,
				call_id: "reused-call",
				name: "second-attempt",
				arguments_json: '{"attempt":2}',
				timestamp,
			},
			{
				kind: "tool_result",
				position: 3,
				call_id: "reused-call",
				name: "first-attempt",
				status: "completed",
				content: "first result",
				timestamp,
			},
			{
				kind: "tool_result",
				position: 4,
				call_id: "reused-call",
				name: "second-attempt",
				status: "completed",
				content: "second result",
				timestamp,
			},
		]);

		expect(markup.match(/<button/g)).toHaveLength(2);
		expect(markup).toContain("first-attempt");
		expect(markup).toContain("second-attempt");
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

	test("marks every visible match while only locating the active result", () => {
		const markup = render(
			[
				{
					kind: "message",
					position: 1,
					role: "user",
					content: "First exact phrase match",
					timestamp,
				},
				{
					kind: "message",
					position: 2,
					role: "assistant",
					content: "Current exact phrase match",
					model: "gpt-5",
					timestamp,
				},
				{
					kind: "message",
					position: 3,
					role: "assistant",
					content: "Final exact phrase match",
					model: "gpt-5",
					timestamp,
				},
			],
			{
				itemKeys: ["desc:0", "desc:1", "desc:2"],
				highlightedMessageKey: "desc:1",
				highlightQuery: "exact phrase",
			},
		);

		expect(markup.match(/<mark/g)).toHaveLength(3);
		expect(markup.match(/data-search-match="true"/g)).toHaveLength(1);
	});
});
