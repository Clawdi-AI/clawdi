import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EntityIcon } from "@/components/entity-icon";

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
