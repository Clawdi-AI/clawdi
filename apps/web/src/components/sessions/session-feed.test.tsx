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

	test("renders the standard inset empty state without blank session cards", () => {
		const markup = renderToStaticMarkup(
			createElement(OverviewSessionList, {
				sessions: [],
				isLoading: false,
				emptyMessage: "No recent sessions",
				sessionLink: () => ({}),
			}),
		);

		expect(markup).not.toContain("overview-session-placeholder");
		expect(markup).not.toContain("aria-hidden");
		expect(markup).toContain('data-slot="empty"');
		expect(markup).toContain("bg-muted/30");
		expect(markup).toContain("No recent sessions");
		expect(markup).not.toContain("sr-only");
		expect(markup).not.toContain("<article");
		expect(markup).not.toContain("<a");
	});
});
