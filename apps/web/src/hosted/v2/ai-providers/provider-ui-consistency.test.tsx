import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { providerBrandIcon } from "@/components/entity-brand-icons";
import { EntityIcon } from "@/components/entity-icon";

const BRANDED_PROVIDER_IDS = [
	"anthropic",
	"deepseek",
	"gemini",
	"grok",
	"groq",
	"kimi",
	"minimax",
	"mistral",
	"openai",
	"openrouter",
	"qwen",
	"stepfun",
	"together",
	"xai",
	"zhipu",
] as const;

describe("AI provider icon coverage", () => {
	test("renders every current branded provider through the official LobeHub React API", () => {
		for (const id of BRANDED_PROVIDER_IDS) {
			const brand = providerBrandIcon(id);
			expect(brand).toBeDefined();
			const markup = renderToStaticMarkup(<EntityIcon kind="provider" id={id} />);
			expect(markup).toContain("<svg");
			expect(markup).toContain('data-icon-source="lobehub"');
			expect(markup).toContain(`aria-label="${brand?.label}"`);
			expect(markup).not.toContain("<img");
		}
	});

	test("keeps released provider aliases on their canonical brand component", () => {
		const aliases = {
			"google-gemini-openai": "gemini",
			google: "gemini",
			"kimi-coding": "kimi",
			moonshot: "kimi",
			"openai-codex": "openai",
			"qwen-dashscope": "qwen",
			"together-ai": "together",
			"xai-grok": "grok",
			"zhipu-glm": "zhipu",
		} as const;

		for (const [alias, canonical] of Object.entries(aliases)) {
			expect(providerBrandIcon(alias)?.icon).toBe(providerBrandIcon(canonical)?.icon);
		}
	});

	test("uses the neutral fallback only for an unknown provider", () => {
		const markup = renderToStaticMarkup(<EntityIcon kind="provider" id="custom-provider" />);
		expect(markup).toContain(">C</span>");
		expect(markup).not.toContain("<svg");
	});
});
