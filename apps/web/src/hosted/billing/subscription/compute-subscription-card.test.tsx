import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ComputeSubscriptionCard } from "./compute-subscription-card";

describe("ComputeSubscriptionCard", () => {
	test("labels reusable compute as available without stale assignment copy", () => {
		const markup = renderToStaticMarkup(
			<ComputeSubscriptionCard
				view={{
					status: { label: "Active", tone: "success" },
					plan: "Performance compute",
					commercialFacts: [],
				}}
				identity={{ kind: "available", label: "Available for a new agent" }}
			/>,
		);

		expect(markup).toContain("Available for a new agent");
		expect(markup).not.toContain("Used by");
		expect(markup).not.toContain("Deleted agent");
		expect(markup).not.toContain("Orphaned");
	});
});
