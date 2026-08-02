import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	OverviewMetadata,
	OverviewResourceDetails,
} from "@/components/dashboard/agent-overview-capabilities";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";

describe("overview resource details", () => {
	test("renders up to three resource names with the existing Badge primitive", () => {
		const markup = renderToStaticMarkup(
			createElement(OverviewResourceDetails, {
				items: [
					"Hosted Agent Project with a deliberately long accessible name",
					"Shared Vault",
					"Research Skills",
					"Hidden fourth resource",
				],
			}),
		);

		expect(markup).toContain('data-testid="overview-resource-summary"');
		expect(markup).not.toContain("text-sm font-medium text-muted-foreground");
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

	test("does not render a badge list for empty details", () => {
		const empty = renderToStaticMarkup(createElement(OverviewResourceDetails, { items: [] }));

		expect(empty).not.toContain('data-testid="overview-resource-badges"');
	});
});

describe("overview card typography", () => {
	test("uses the existing small Card title and description hierarchy", () => {
		const markup = renderToStaticMarkup(
			createElement(
				Card,
				{ size: "sm" },
				createElement(CardTitle, null, "Projects"),
				createElement(CardDescription, null, "3 projects"),
			),
		);

		expect(markup).toContain('data-size="sm"');
		expect(markup).toContain('data-slot="card-title"');
		expect(markup).toContain("group-data-[size=sm]/card:text-sm");
		expect(markup).toContain('data-slot="card-description"');
		expect(markup).toContain("text-sm text-muted-foreground");
		expect(markup).not.toContain("font-semibold");
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
