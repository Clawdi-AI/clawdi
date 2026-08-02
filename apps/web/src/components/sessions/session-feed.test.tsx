import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OverviewSessionList } from "@/components/sessions/session-feed";

describe("OverviewSessionList", () => {
	test("renders three loading rows without session links", () => {
		const markup = renderToStaticMarkup(
			createElement(OverviewSessionList, {
				sessions: [],
				isLoading: true,
				emptyMessage: "No recent sessions",
				sessionLink: () => ({}),
			}),
		);

		expect(markup.match(/data-testid="overview-session-skeleton-row"/g)).toHaveLength(3);
		expect(markup.match(/aria-hidden="true"/g)).toHaveLength(3);
		expect(markup).not.toContain("<article");
		expect(markup).not.toContain("<a");
	});

	test("renders an accessible empty state and three inert visual placeholders", () => {
		const markup = renderToStaticMarkup(
			createElement(OverviewSessionList, {
				sessions: [],
				isLoading: false,
				emptyMessage: "No recent sessions",
				sessionLink: () => ({}),
			}),
		);

		expect(markup.match(/data-testid="overview-session-placeholder"/g)).toHaveLength(3);
		expect(markup.match(/aria-hidden="true"/g)).toHaveLength(3);
		expect(markup).toContain('role="status"');
		expect(markup).toContain("No recent sessions");
		expect(markup).toContain("pointer-events-none");
		expect(markup).not.toContain("<article");
		expect(markup).not.toContain("<a");
	});
});
