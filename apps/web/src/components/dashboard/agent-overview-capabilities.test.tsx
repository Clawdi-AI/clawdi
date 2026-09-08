import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OverviewModuleError } from "@/components/dashboard/agent-overview-capabilities";
import { overviewProjectsModule } from "@/components/dashboard/agent-overview-resource-bodies";

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

	test("retains a known project count when a background refresh fails", () => {
		expect(
			overviewProjectsModule({
				bindings: { count: 3, isLoading: false, error: new Error("Offline") },
			}).description,
		).toBe("3 linked projects");
	});

	test("keeps retry support on the shared non-module error surface", () => {
		const markup = renderToStaticMarkup(
			createElement(OverviewModuleError, { label: "Sessions", onRetry: () => undefined }),
		);

		expect(markup).toContain("Retry");
	});
});
