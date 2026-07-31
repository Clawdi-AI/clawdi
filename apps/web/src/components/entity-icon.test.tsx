import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FRAMEWORK_BRAND_ICON_IDS } from "@/components/entity-brand-icon-ids";
import { EntityIcon } from "@/components/entity-icon";

const SIZES = ["sm", "md", "lg"] as const;

describe("EntityIcon LobeHub brands", () => {
	test("uses the shared larger mark without clipping framework or provider tiles", () => {
		for (const kindAndId of [
			...FRAMEWORK_BRAND_ICON_IDS.map((id) => ({ kind: "framework" as const, id })),
			{ kind: "provider" as const, id: "openai" },
		]) {
			for (const size of SIZES) {
				const markup = renderToStaticMarkup(<EntityIcon {...kindAndId} size={size} />);
				expect(markup).toContain('data-icon-source="lobehub"');
				expect(markup).toContain('width="84%"');
				expect(markup).toContain('height="84%"');
			}
		}
	});

	test("keeps unknown frameworks on the existing monogram fallback", () => {
		const markup = renderToStaticMarkup(
			<EntityIcon kind="framework" id="custom-agent" label="Custom agent" size="sm" />,
		);
		expect(markup).toContain(">C</div>");
		expect(markup).not.toContain("<svg");
		expect(markup).not.toContain("<img");
	});
});

describe("EntityIcon channels", () => {
	test("preserves the existing CDN PNG for every supported channel", () => {
		for (const id of ["telegram", "discord", "whatsapp", "slack"]) {
			const markup = renderToStaticMarkup(
				<EntityIcon kind="channel" id={id} label={id} size="lg" />,
			);
			expect(markup).toContain("<img");
			expect(markup).toContain(`src="https://assets.clawdi.ai/icons/${id}.png"`);
			expect(markup).toContain(`alt="${id}"`);
			expect(markup).toContain('width="48"');
			expect(markup).toContain('height="48"');
			expect(markup).not.toContain("<svg");
		}
	});
});
