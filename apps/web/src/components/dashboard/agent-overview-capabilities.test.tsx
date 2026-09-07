import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	AgentOverviewCapabilitiesSkeleton,
	OverviewDescriptionSkeleton,
	OverviewMetadata,
	OverviewModuleError,
} from "@/components/dashboard/agent-overview-capabilities";
import { overviewProjectsModule } from "@/components/dashboard/agent-overview-resource-bodies";
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
	test.each([
		[0, "No projects linked"],
		[1, "1 linked project"],
		[2, "2 linked projects"],
	] as const)("uses sentence case for the project count (%s)", (count, description) => {
		expect(
			overviewProjectsModule({ bindings: { count, isLoading: false, error: null } }).description,
		).toBe(description);
	});
	test("keeps loading summaries on the standard description line height", () => {
		const markup = renderToStaticMarkup(
			createElement(OverviewDescriptionSkeleton, { label: "projects" }),
		);

		expect(markup).toContain("h-lh w-20");
		expect(markup).not.toContain("h-4 w-20");
	});

	test("retains a known project count when a background refresh fails", () => {
		expect(
			overviewProjectsModule({
				bindings: { count: 3, isLoading: false, error: new Error("Offline") },
			}).description,
		).toBe("3 linked projects");
	});

	test("uses the same compact Card grid for initial overview skeletons", () => {
		const connected = renderToStaticMarkup(
			createElement(AgentOverviewCapabilitiesSkeleton, { variant: "connected" }),
		);
		const hosted = renderToStaticMarkup(
			createElement(AgentOverviewCapabilitiesSkeleton, { variant: "hosted" }),
		);

		expect(connected.match(/data-overview-module-skeleton=/g)).toHaveLength(5);
		expect(hosted.match(/data-overview-module-skeleton=/g)).toHaveLength(6);
		expect(hosted).toContain('data-overview-module-skeleton="plugins"');
		expect(hosted).toContain('data-overview-layout="two-column"');
		expect(hosted).toContain("h-full min-w-0 border border-foreground/10 py-3 ring-0");
		expect(hosted).toContain("grid-rows-1 content-center gap-0");
		expect(hosted).not.toContain("h-40");
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
