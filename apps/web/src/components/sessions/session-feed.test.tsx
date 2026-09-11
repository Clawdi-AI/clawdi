import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OverviewSessionList } from "@/components/sessions/session-feed";

describe("OverviewSessionList", () => {
	test("renders loading state without session links", () => {
		const markup = renderToStaticMarkup(
			createElement(OverviewSessionList, {
				sessions: [],
				isLoading: true,
				emptyMessage: "No recent sessions",
				sessionLink: () => ({}),
			}),
		);

		expect(markup).not.toContain("<article");
		expect(markup).not.toContain("<a");
	});

	test("renders three non-interactive empty slots with one empty message", () => {
		const markup = renderToStaticMarkup(
			createElement(OverviewSessionList, {
				sessions: [],
				isLoading: false,
				emptyMessage: "No recent sessions",
				sessionLink: () => ({}),
			}),
		);

		expect(markup.match(/data-testid="overview-session-placeholder"/g)).toHaveLength(3);
		expect(markup.match(/aria-hidden="true"/g)).toHaveLength(2);
		expect(markup.match(/No recent sessions/g)).toHaveLength(1);
		expect(markup).not.toContain("animate-pulse");
		expect(markup).not.toContain("<article");
		expect(markup).not.toContain("<a");
	});
});
