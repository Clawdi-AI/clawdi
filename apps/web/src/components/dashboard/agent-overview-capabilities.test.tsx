import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OverviewMetadata } from "@/components/dashboard/agent-overview-capabilities";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";

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
