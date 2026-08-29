import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PROVIDER_BRAND_ICON_IDS } from "@/components/entity-brand-icon-ids";
import { providerBrandIcon } from "@/components/entity-brand-icons";
import { EntityIcon } from "@/components/entity-icon";

describe("AI provider icon coverage", () => {
	test("imports official leaf components without the compounded root or broad SSR transform", () => {
		const iconSource = readFileSync(
			new URL("../../../components/entity-brand-icons.ts", import.meta.url),
			"utf8",
		);
		const viteSource = readFileSync(new URL("../../../../vite.config.ts", import.meta.url), "utf8");
		expect(iconSource).not.toMatch(/from\s+["']@lobehub\/icons["']/);
		expect(iconSource).toContain("@lobehub/icons/es/OpenClaw/components/Color.js");
		expect(iconSource).toContain("@lobehub/icons/es/HermesAgent/components/Mono.js");
		expect(iconSource).toContain("@lobehub/icons/es/ClaudeCode/components/Color.js");
		expect(iconSource).toContain("@lobehub/icons/es/Codex/components/Inner.js");
		expect(iconSource).toContain("@lobehub/icons/es/Pi/components/Mono.js");
		expect(iconSource).toContain("@lobehub/icons/es/OpenCode/components/Mono.js");
		expect(viteSource).toContain('noExternal: ["@lobehub/icons"]');
		expect(viteSource).not.toContain("noExternal: [/^@lobehub");
		expect(viteSource).not.toContain("optimizeDeps");
	});

	test("renders every current branded provider through the official LobeHub React API", () => {
		for (const id of PROVIDER_BRAND_ICON_IDS) {
			const brand = providerBrandIcon(id);
			expect(brand).toBeDefined();
			const markup = renderToStaticMarkup(createElement(EntityIcon, { kind: "provider", id }));
			expect(markup).toContain("<svg");
			expect(markup).toContain('data-icon-source="lobehub"');
			expect(markup).toContain(`aria-label="${brand?.label}"`);
			expect(markup).toContain('width="84%"');
			expect(markup).toContain('height="84%"');
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
