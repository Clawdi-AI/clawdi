import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EntityChoiceCard } from "@/components/entity-card";

function renderChoice(selected?: boolean) {
	return renderToStaticMarkup(
		<EntityChoiceCard
			icon={<span>Icon</span>}
			title="Choice"
			badge={<span>Badge</span>}
			selected={selected}
		/>,
	);
}

describe("EntityChoiceCard", () => {
	test("keeps a centered trailing indicator slot for selectable cards", () => {
		const selected = renderChoice(true);
		const unselected = renderChoice(false);

		for (const markup of [selected, unselected]) {
			expect(markup).toContain('data-slot="entity-choice-indicator"');
			expect(markup).toContain("self-center");
		}
		expect(selected).toContain("lucide-check");
		expect(unselected).not.toContain("lucide-check");
	});

	test("does not reserve selection space for action cards", () => {
		expect(renderChoice()).not.toContain('data-slot="entity-choice-indicator"');
	});
});
