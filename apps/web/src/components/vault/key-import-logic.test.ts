import { describe, expect, test } from "bun:test";
import { buildKeyImportPreview } from "./key-import-logic";

describe("buildKeyImportPreview", () => {
	test("uses the robust vault parser for env lines", () => {
		const plan = buildKeyImportPreview(
			`
				API_KEY=one
				EMPTY_VALUE=
				WITH_COMMENT=value # comment
			`,
			new Set(),
			false,
		);

		expect(plan.parsed.errors).toEqual([]);
		expect(plan.fields).toEqual({
			API_KEY: "one",
			EMPTY_VALUE: "",
			WITH_COMMENT: "value",
		});
		expect(plan.summary).toEqual({ created: 3, updated: 0, skipped: 0 });
	});

	test("supports flat JSON imports", () => {
		const plan = buildKeyImportPreview('{"api_key":"secret","ENABLED":true}', new Set(), false);

		expect(plan.fields).toEqual({ API_KEY: "secret", ENABLED: "true" });
		expect(plan.preview.map((entry) => entry.action)).toEqual(["create", "create"]);
	});

	test("skips existing keys by default and can mark them for update", () => {
		const existing = new Set(["API_KEY"]);
		const skipPlan = buildKeyImportPreview("API_KEY=new\nOTHER=ok", existing, false);
		const updatePlan = buildKeyImportPreview("API_KEY=new\nOTHER=ok", existing, true);

		expect(skipPlan.fields).toEqual({ OTHER: "ok" });
		expect(skipPlan.summary).toEqual({ created: 1, updated: 0, skipped: 1 });
		expect(skipPlan.preview.map((entry) => entry.action)).toEqual(["skip", "create"]);
		expect(updatePlan.fields).toEqual({ API_KEY: "new", OTHER: "ok" });
		expect(updatePlan.summary).toEqual({ created: 1, updated: 1, skipped: 0 });
		expect(updatePlan.preview.map((entry) => entry.action)).toEqual(["update", "create"]);
	});

	test("surfaces parser errors without importable fields", () => {
		const plan = buildKeyImportPreview("API_KEY=one\napi_key=two", new Set(), false);

		expect(plan.parsed.errors).toEqual([
			'Line 2: duplicate key "api_key" (same as "API_KEY" after normalization to "API_KEY").',
		]);
		expect(plan.preview).toEqual([]);
		expect(plan.fields).toEqual({});
	});
});
