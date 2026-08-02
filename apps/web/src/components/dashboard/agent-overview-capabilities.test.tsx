import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OverviewSummaryRows } from "@/components/dashboard/agent-overview-capabilities";

describe("overview summary rows", () => {
	test("renders resource names as a compact flat list", () => {
		const markup = renderToStaticMarkup(
			createElement(OverviewSummaryRows, {
				items: ["Hosted Agent Project", "Shared Vault", "Telegram: Research"],
				empty: "No resources",
			}),
		);

		expect(markup).toContain('data-testid="overview-summary-list"');
		for (const item of ["Hosted Agent Project", "Shared Vault", "Telegram: Research"])
			expect(markup).toContain(item);
		expect(markup).not.toContain("rounded");
		expect(markup).not.toContain("border");
		expect(markup).not.toContain("divide-y");
		expect(markup).not.toContain("bg-");
	});

	test("keeps the existing empty state and three-row limit", () => {
		const populated = renderToStaticMarkup(
			createElement(OverviewSummaryRows, {
				items: ["One", "Two", "Three", "Four"],
				empty: "No resources",
			}),
		);
		const empty = renderToStaticMarkup(
			createElement(OverviewSummaryRows, { items: [], empty: "No resources" }),
		);

		expect(populated).toContain("One");
		expect(populated).toContain("Three");
		expect(populated).not.toContain("Four");
		expect(empty).toContain("No resources");
		expect(empty).not.toContain('data-testid="overview-summary-list"');
	});
});
