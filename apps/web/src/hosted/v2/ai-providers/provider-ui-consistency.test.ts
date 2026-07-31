import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const chooserSource = readFileSync(new URL("./provider-chooser.tsx", import.meta.url), "utf8");
const fieldsSource = readFileSync(new URL("./provider-fields-form.tsx", import.meta.url), "utf8");

describe("AI provider design-system consistency", () => {
	test("uses the canonical search and entity choice components", () => {
		expect(chooserSource).toContain('import { SearchInput } from "@/components/ui/search-input";');
		expect(chooserSource).not.toContain('from "@/components/ui/input"');
		expect(chooserSource).not.toContain('from "@/components/ui/label"');
		expect(chooserSource).toContain('id="custom_openai_compatible"');
		expect(chooserSource).toContain("<EntityChoiceCard");
		expect(chooserSource).not.toContain("border-dashed");
	});

	test("keeps disclosure controls canonical and Advanced user-collapsible", () => {
		expect(chooserSource).toContain("<ChevronDown");
		expect(fieldsSource).toContain("<ChevronDown");
		expect(chooserSource).not.toContain("⌄");
		expect(fieldsSource).not.toContain("⌄");
		expect(fieldsSource).toContain("const defaultAdvancedOpen = meta.custom || isEdit");
		expect(fieldsSource).toContain("details.open = defaultAdvancedOpen");
		expect(fieldsSource).toContain("ref={initializeAdvancedDetails}");
		expect(fieldsSource).not.toContain("open={meta.custom || isEdit}");
	});
});
