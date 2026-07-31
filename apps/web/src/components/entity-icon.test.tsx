import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EntityIcon } from "@/components/entity-icon";

const FRAMEWORKS = ["openclaw", "hermes", "claude-code", "codex"] as const;
const SIZES = ["sm", "md", "lg"] as const;

describe("EntityIcon LobeHub brands", () => {
	test("uses the shared larger mark without clipping framework or provider tiles", () => {
		for (const kindAndId of [
			...FRAMEWORKS.map((id) => ({ kind: "framework" as const, id })),
			{ kind: "provider" as const, id: "openai" },
		]) {
			for (const size of SIZES) {
				const markup = renderToStaticMarkup(<EntityIcon {...kindAndId} size={size} />);
				expect(markup).toContain('data-icon-source="lobehub"');
				expect(markup).toContain('width="72%"');
				expect(markup).toContain('height="72%"');
			}
		}
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
