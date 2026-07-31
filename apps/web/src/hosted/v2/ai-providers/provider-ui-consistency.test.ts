import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const entityIconSource = readFileSync(
	new URL("../../../components/entity-icon.tsx", import.meta.url),
	"utf8",
);
const presetsSource = readFileSync(new URL("./provider-presets.ts", import.meta.url), "utf8");
const typesSource = readFileSync(new URL("./provider-types.ts", import.meta.url), "utf8");

describe("AI provider static boundaries", () => {
	test("keeps only the managed-model alias required for a provider logo", () => {
		expect(entityIconSource).toContain('"kimi-coding": "kimi"');
		expect(entityIconSource).not.toContain('"openai-codex": "openai"');
	});

	test("keeps unapproved icon catalogs and retired metadata out of provider UI", () => {
		expect(entityIconSource).not.toContain("models.dev");
		expect(entityIconSource).not.toContain("lobehub");
		expect(presetsSource).not.toContain("website_url");
		expect(presetsSource).not.toContain("ProviderPresetCategory");
		expect(typesSource).not.toContain("tint:");
	});
});
