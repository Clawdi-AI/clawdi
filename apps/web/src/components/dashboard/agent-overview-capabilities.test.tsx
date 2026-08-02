import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	OverviewMetadata,
	OverviewResourceSummary,
} from "@/components/dashboard/agent-overview-capabilities";

describe("overview resource summary", () => {
	test("renders up to three resource names with the existing Badge primitive", () => {
		const markup = renderToStaticMarkup(
			createElement(OverviewResourceSummary, {
				primary: "4 projects",
				items: [
					"Hosted Agent Project with a deliberately long accessible name",
					"Shared Vault",
					"Research Skills",
					"Hidden fourth resource",
				],
			}),
		);

		expect(markup).toContain('data-testid="overview-resource-summary"');
		expect(markup).toContain('data-testid="overview-resource-badges"');
		expect(markup).toContain('data-slot="badge"');
		for (const item of [
			"Hosted Agent Project with a deliberately long accessible name",
			"Shared Vault",
			"Research Skills",
		])
			expect(markup).toContain(item);
		expect(markup).not.toContain("Hidden fourth resource");
		expect(markup).toContain(
			'title="Hosted Agent Project with a deliberately long accessible name"',
		);
		expect(markup).toContain(
			'aria-label="Hosted Agent Project with a deliberately long accessible name"',
		);
		expect(markup).toContain("truncate");
	});

	test("does not duplicate an empty primary value with an empty badge list", () => {
		const empty = renderToStaticMarkup(
			createElement(OverviewResourceSummary, { primary: "No projects added", items: [] }),
		);

		expect(empty.match(/No projects added/g)).toHaveLength(1);
		expect(empty).not.toContain('data-testid="overview-resource-badges"');
	});
});

describe("overview metadata", () => {
	test("uses the shared muted metadata hierarchy for labels and values", () => {
		const markup = renderToStaticMarkup(
			createElement(OverviewMetadata, {
				items: [
					{ label: "Machine", value: "workstation.local" },
					{ label: "Last seen", value: "Just now" },
				],
			}),
		);

		expect(markup).toContain("space-y-2 text-xs text-muted-foreground");
		expect(markup).not.toContain("text-sm");
		expect(markup).not.toContain("font-medium");
	});
});
