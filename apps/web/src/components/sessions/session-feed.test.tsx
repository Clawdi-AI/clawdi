import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OverviewSessionList } from "@/components/sessions/session-feed";

describe("OverviewSessionList", () => {
	test("renders three loading rows", () => {
		const markup = renderToStaticMarkup(
			createElement(OverviewSessionList, {
				sessions: [],
				isLoading: true,
				emptyMessage: "No recent sessions",
				sessionLink: () => ({}),
			}),
		);

		expect(markup.match(/data-testid="overview-session-skeleton-row"/g)).toHaveLength(3);
	});
});
