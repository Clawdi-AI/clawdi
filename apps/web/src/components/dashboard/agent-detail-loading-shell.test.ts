import { beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

type DetailSkeleton =
	typeof import("@/components/dashboard/connected-agent-detail").ConnectedAgentDetailSkeleton;

let detailSkeleton: DetailSkeleton | null = null;

beforeAll(async () => {
	process.env.VITE_CLAWDI_API_URL = "http://localhost:8000";
	process.env.VITE_CLAWDI_DEPLOY_API_URL = "http://localhost:50021";
	process.env.VITE_CLERK_PUBLISHABLE_KEY = "pk_test_dummy";
	const module = await import("@/components/dashboard/connected-agent-detail");
	detailSkeleton = module.ConnectedAgentDetailSkeleton;
});

function render(section: Parameters<DetailSkeleton>[0]["section"]): string {
	if (!detailSkeleton) throw new Error("agent detail loading shell was not loaded");
	return renderToStaticMarkup(createElement(detailSkeleton, { hosted: true, section }));
}

describe("agent detail loading shells", () => {
	test("uses full-bleed live-tool geometry for live sections", () => {
		for (const section of ["console", "files", "terminal"] as const) {
			const markup = render(section);
			expect(markup).toContain('data-testid="agent-live-tool-loading-shell"');
			expect(markup).toContain("h-[calc(100svh-var(--header-height))]");
			expect(markup).not.toContain("min-h-[calc(100svh-var(--header-height))]");
			expect(markup).not.toContain("data-agent-detail-skeleton");
			expect(markup).not.toContain("overview-status-card-skeleton");
		}
	});

	test("keeps overview structure out of ordinary section fallbacks", () => {
		const memories = render("memories");
		const overview = render("overview");

		expect(memories).toContain('data-agent-detail-section="memories"');
		expect(memories).not.toContain("overview-status-card-skeleton");
		expect(overview).toContain('data-agent-detail-section="overview"');
		expect(overview).toContain("overview-status-card-skeleton");
	});
});
