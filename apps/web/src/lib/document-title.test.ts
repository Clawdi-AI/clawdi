import { describe, expect, test } from "bun:test";
import { APP_TITLE, formatDocumentTitle } from "@/lib/document-title";

describe("formatDocumentTitle", () => {
	test("formats route titles with the app name", () => {
		expect(formatDocumentTitle("Sessions")).toBe(`Sessions · ${APP_TITLE}`);
	});

	test("trims registered breadcrumb titles", () => {
		expect(formatDocumentTitle("  Project Alpha  ")).toBe(`Project Alpha · ${APP_TITLE}`);
	});

	test("falls back to the app title for empty values", () => {
		expect(formatDocumentTitle(null)).toBe(APP_TITLE);
		expect(formatDocumentTitle("   ")).toBe(APP_TITLE);
	});
});
