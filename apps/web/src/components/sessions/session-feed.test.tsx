import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OverviewSessionList } from "@/components/sessions/session-feed";

describe("OverviewSessionList", () => {
	test("reuses the single SessionCard structure without a compact visual prop", () => {
		const source = readFileSync(new URL("./session-feed.tsx", import.meta.url), "utf8");

		expect(source).toContain("export function SessionCard(");
		expect(source.match(/<SessionCard\b/g)).toHaveLength(3);
		expect(source.match(/<SessionCardSkeleton\b/g)).toHaveLength(2);
		expect(source).not.toContain("SessionFeedCard");
		expect(source).not.toMatch(/\bcompact\b/);
		expect(source).not.toContain("EntityHeader");
		expect(source.match(/data-testid="session-card-title"/g)).toHaveLength(1);
		expect(source.match(/data-testid="session-card-meta"/g)).toHaveLength(1);
	});

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
