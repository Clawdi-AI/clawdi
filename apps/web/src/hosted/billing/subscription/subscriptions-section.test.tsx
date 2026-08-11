import { beforeAll, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

type SubscriptionsSectionModule =
	typeof import("@/hosted/billing/subscription/subscriptions-section");

let SubscriptionAgentLink: SubscriptionsSectionModule["SubscriptionAgentLink"] | null = null;
let SubscriptionLoadMore: SubscriptionsSectionModule["SubscriptionLoadMore"] | null = null;

beforeAll(async () => {
	process.env.VITE_CLAWDI_API_URL = "http://localhost:8000";
	process.env.VITE_CLAWDI_DEPLOY_API_URL = "http://localhost:50021";
	process.env.VITE_CLERK_PUBLISHABLE_KEY = "pk_test_dummy";
	const module = await import("@/hosted/billing/subscription/subscriptions-section");
	SubscriptionAgentLink = module.SubscriptionAgentLink;
	SubscriptionLoadMore = module.SubscriptionLoadMore;
});

describe("SubscriptionsSection", () => {
	test("keeps deleted agents unlinked and exposes pagination", () => {
		if (!SubscriptionAgentLink || !SubscriptionLoadMore) {
			throw new Error("Subscriptions section components were not loaded");
		}
		const deletedAgent = renderToStaticMarkup(<SubscriptionAgentLink deploymentId={null} />);
		expect(deletedAgent).toContain("Deleted agent");
		expect(deletedAgent).not.toContain("View agent");
		expect(deletedAgent).not.toContain("href=");

		const loadMore = renderToStaticMarkup(
			<SubscriptionLoadMore isLoading={false} onLoadMore={() => undefined} />,
		);
		expect(loadMore).toContain("Load more");
	});
});
