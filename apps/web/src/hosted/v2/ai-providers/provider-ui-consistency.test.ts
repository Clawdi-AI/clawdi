import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const entityIconSource = readFileSync(
	new URL("../../../components/entity-icon.tsx", import.meta.url),
	"utf8",
);
const presetsSource = readFileSync(new URL("./provider-presets.ts", import.meta.url), "utf8");
const typesSource = readFileSync(new URL("./provider-types.ts", import.meta.url), "utf8");
const require = createRequire(import.meta.url);
const lobeIconDirectory = join(
	dirname(require.resolve("@lobehub/icons-static-svg/package.json")),
	"icons",
);

describe("AI provider static boundaries", () => {
	test("maps every current branded provider to an official package-local LobeHub SVG", () => {
		const officialAssets = [
			"anthropic.svg",
			"deepseek-color.svg",
			"gemini-color.svg",
			"grok.svg",
			"groq.svg",
			"kimi.svg",
			"minimax-color.svg",
			"mistral-color.svg",
			"openai.svg",
			"openrouter-color.svg",
			"qwen-color.svg",
			"stepfun-color.svg",
			"together-color.svg",
			"xai.svg",
			"zhipu-color.svg",
		];
		for (const asset of officialAssets) {
			expect(readFileSync(join(lobeIconDirectory, asset), "utf8")).toContain("<svg");
			expect(entityIconSource).toContain(`@lobehub/icons-static-svg/icons/${asset}`);
		}
		expect(entityIconSource).toContain('"openai-codex": "openai"');
		expect(entityIconSource).toContain('"kimi-coding": "kimi"');
		expect(entityIconSource).toContain('moonshot: "kimi"');
		expect(entityIconSource).toContain('"google-gemini-openai": "gemini"');
		expect(entityIconSource).toContain('google: "gemini"');
		expect(entityIconSource).toContain('"qwen-dashscope": "qwen"');
		expect(entityIconSource).toContain('"zhipu-glm": "zhipu"');
		expect(entityIconSource).toContain('"together-ai": "together"');
		expect(entityIconSource).toContain('grok: { label: "Grok", monochrome: true, src: grokIcon }');
		expect(entityIconSource).toContain('xai: { label: "xAI", monochrome: true, src: xAiIcon }');
		expect(entityIconSource).toContain('"xai-grok": "grok"');
		expect(entityIconSource).toContain('data-icon-source="lobehub"');
		expect(entityIconSource).not.toContain("cdn.simpleicons.org");
	});

	test("keeps unapproved icon catalogs and retired metadata out of provider UI", () => {
		expect(entityIconSource).not.toContain("models.dev");
		expect(presetsSource).not.toContain("website_url");
		expect(presetsSource).not.toContain("ProviderPresetCategory");
		expect(typesSource).not.toContain("tint:");
	});
});
