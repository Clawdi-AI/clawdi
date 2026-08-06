import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EntityRow, HeroCard, HeroCardSkeleton } from "@/components/entity-card";

describe("HeroCard", () => {
	test("keeps identity, metadata, actions, and truncation labels in the shared card shell", () => {
		const markup = renderToStaticMarkup(
			<HeroCard
				icon={<span>icon</span>}
				title="Customer onboarding"
				description="Reusable onboarding resources"
				footer={["12 skills", "3 vaults"]}
				actions={
					<button type="button" aria-label="Share Customer onboarding">
						Share
					</button>
				}
			/>,
		);

		expect(markup).toContain('data-slot="entity-card"');
		expect(markup).toContain('data-variant="resource"');
		expect(markup).toContain('title="Customer onboarding"');
		expect(markup).toContain('title="12 skills"');
		expect(markup).toContain('aria-label="Share Customer onboarding"');
		expect(markup).toContain("group-focus-within:opacity-100");
	});

	test("keeps dense catalog rows on the compact chassis", () => {
		const markup = renderToStaticMarkup(
			<EntityRow icon={<span>icon</span>} title="GitHub" meta="Source control" />,
		);

		expect(markup).toContain('data-slot="entity-card"');
		expect(markup).toContain('data-variant="compact"');
		expect(markup).toContain('title="GitHub"');
		expect(markup).toContain('title="Source control"');
	});

	test("uses the same shell geometry for compact and default loading cards", () => {
		const defaultMarkup = renderToStaticMarkup(<HeroCardSkeleton />);
		const compactMarkup = renderToStaticMarkup(<HeroCardSkeleton compact />);

		for (const markup of [defaultMarkup, compactMarkup]) {
			expect(markup).toContain('data-slot="hero-card-skeleton"');
			expect(markup).toContain('aria-hidden="true"');
			expect(markup).toContain("rounded-xl");
		}
		expect(defaultMarkup).toContain("min-h-36");
		expect(compactMarkup).toContain("min-h-28");
	});
});
