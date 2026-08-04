import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const breadcrumb = readFileSync(new URL("./app-breadcrumb.tsx", import.meta.url), "utf8");

describe("AppBreadcrumb responsive trail", () => {
	test("keeps only the current page visible below the existing sm breakpoint", () => {
		expect(breadcrumb).toContain(
			'<BreadcrumbItem className={isLast ? undefined : "hidden sm:inline-flex"}>',
		);
		expect(breadcrumb).toContain('<BreadcrumbSeparator className="hidden sm:block" />');
		expect(breadcrumb).not.toContain("useIsMobile");
		expect(breadcrumb).not.toContain("matchMedia");
		// Fragment keeps the breadcrumb <li> items and separators as direct <ol> children.
		expect(breadcrumb).toContain("<Fragment key={href}>");
		expect(breadcrumb).not.toContain('<span key={href} className="contents">');
	});

	test("returns Project-scoped resource crumbs to their independent collection", () => {
		expect(breadcrumb).toContain('typeof search.project === "string"');
		expect(breadcrumb).toContain("agentProjectResourceHref(route.agentId, projectId");
		expect(breadcrumb).toContain("route.section,");
		expect(breadcrumb).toContain('route.section === "projects" && route.projectId');
	});
});
