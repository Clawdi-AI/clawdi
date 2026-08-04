import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	AgentOverviewCapabilitiesSkeleton,
	OverviewDescriptionSkeleton,
	OverviewMetadata,
	OverviewModuleError,
	overviewModuleAccessibleName,
} from "@/components/dashboard/agent-overview-capabilities";
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

describe("overview modules", () => {
	test("keeps loading summaries on the standard description line height", () => {
		const markup = renderToStaticMarkup(
			createElement(OverviewDescriptionSkeleton, { label: "projects" }),
		);

		expect(markup).toContain("h-5 w-20");
		expect(markup).not.toContain("h-4 w-20");
	});

	test("uses the same compact Card grid for initial overview skeletons", () => {
		const connected = renderToStaticMarkup(
			createElement(AgentOverviewCapabilitiesSkeleton, { variant: "connected" }),
		);
		const hosted = renderToStaticMarkup(
			createElement(AgentOverviewCapabilitiesSkeleton, { variant: "hosted" }),
		);

		expect(connected.match(/data-overview-module-skeleton=/g)).toHaveLength(2);
		expect(hosted.match(/data-overview-module-skeleton=/g)).toHaveLength(4);
		expect(hosted).toContain("h-full min-w-0 py-3");
		expect(hosted).toContain("grid-rows-1 content-center gap-0");
		expect(hosted).not.toContain("h-40");
	});

	test("includes all-agent access in scoped card accessible names", () => {
		expect(overviewModuleAccessibleName("Memories", "All agents")).toBe("Memories, All agents");
		expect(overviewModuleAccessibleName("Projects")).toBe("Projects");
	});

	test("represents module errors only as the unavailable description", () => {
		const source = readFileSync(
			new URL("./agent-overview-resource-bodies.tsx", import.meta.url),
			"utf8",
		);

		expect(source).not.toContain("error: <");
		expect(source).not.toContain("OverviewModuleError");
		expect(source).toContain('return { description: "Unavailable right now" }');
	});

	test("keeps retry support on the shared non-module error surface", () => {
		const markup = renderToStaticMarkup(
			createElement(OverviewModuleError, { label: "Sessions", onRetry: () => undefined }),
		);

		expect(markup).toContain("Retry");
	});
});
