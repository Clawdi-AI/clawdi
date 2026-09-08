import { describe, expect, test } from "bun:test";
import { NATIVE_AI_PROVIDERS } from "@clawdi/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PROVIDER_BRAND_ICON_IDS } from "@/components/entity-brand-icon-ids";
import { providerBrandIcon } from "@/components/entity-brand-icons";
import { EntityIcon } from "@/components/entity-icon";

describe("AI provider icon coverage", () => {
	test("renders every current branded provider through the official LobeHub React API", () => {
		for (const id of PROVIDER_BRAND_ICON_IDS) {
			const brand = providerBrandIcon(id);
			expect(brand).toBeDefined();
			const markup = renderToStaticMarkup(createElement(EntityIcon, { kind: "provider", id }));
			expect(markup).toContain("<svg");
			expect(markup).toContain('data-icon-source="lobehub"');
			expect(markup).toContain(`aria-label="${brand?.label}"`);
			expect(markup).not.toContain("<img");
		}
	});

	test("every native connection and runtime identity resolves to a LobeHub brand", () => {
		const identities = new Set(
			NATIVE_AI_PROVIDERS.flatMap((route) => [
				route.id,
				route.openclaw.provider,
				route.hermes.provider,
			]),
		);
		for (const id of identities) {
			expect(providerBrandIcon(id), `Missing provider brand: ${id}`).toBeDefined();
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
			"zhipu-glm": "zai",
		} as const;

		for (const [alias, canonical] of Object.entries(aliases)) {
			expect(providerBrandIcon(alias)?.icon).toBe(providerBrandIcon(canonical)?.icon);
		}
	});

	test("uses the neutral fallback only for an unknown provider", () => {
		const markup = renderToStaticMarkup(
			createElement(EntityIcon, { kind: "provider", id: "custom-provider" }),
		);
		expect(markup).toContain(">C</span>");
		expect(markup).not.toContain("<svg");
	});
});
