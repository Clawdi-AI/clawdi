import { beforeAll, describe, expect, test } from "bun:test";
import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

type SubscriptionsSectionModule =
	typeof import("@/hosted/billing/subscription/subscriptions-section");

let SubscriptionAgentLink: SubscriptionsSectionModule["SubscriptionAgentLink"] | null = null;
let SubscriptionLoadMore: SubscriptionsSectionModule["SubscriptionLoadMore"] | null = null;
let subscriptionPaymentSourceLabel:
	| SubscriptionsSectionModule["subscriptionPaymentSourceLabel"]
	| null = null;

beforeAll(async () => {
	process.env.VITE_CLAWDI_API_URL = "http://localhost:8000";
	process.env.VITE_CLAWDI_DEPLOY_API_URL = "http://localhost:50021";
	process.env.VITE_CLERK_PUBLISHABLE_KEY = "pk_test_dummy";
	const module = await import("@/hosted/billing/subscription/subscriptions-section");
	SubscriptionAgentLink = module.SubscriptionAgentLink;
	SubscriptionLoadMore = module.SubscriptionLoadMore;
	subscriptionPaymentSourceLabel = module.subscriptionPaymentSourceLabel;
});

describe("SubscriptionsSection", () => {
	test("links a named agent to its billing plan and keeps deleted agents unlinked", () => {
		if (!SubscriptionAgentLink || !SubscriptionLoadMore) {
			throw new Error("Subscriptions section components were not loaded");
		}
		const namedAgent = SubscriptionAgentLink({
			deploymentId: "hdep_live",
			agentName: "Production agent",
		});
		if (!isValidElement(namedAgent)) throw new Error("Expected a named agent link");
		expect(namedAgent.props).toMatchObject({
			children: "Production agent",
			to: "/agents/$id/$section",
			params: { id: "hdep_live", section: "settings" },
			search: { source: "on-clawdi", settings: "billing-plan" },
		});

		for (const deletedAgent of [
			renderToStaticMarkup(<SubscriptionAgentLink deploymentId={null} agentName={null} />),
			renderToStaticMarkup(<SubscriptionAgentLink deploymentId="hdep_stale" agentName={null} />),
			renderToStaticMarkup(<SubscriptionAgentLink deploymentId={null} agentName="Stale agent" />),
		]) {
			expect(deletedAgent).toContain("Deleted agent");
			expect(deletedAgent).not.toContain("href=");
		}

		const loadMore = renderToStaticMarkup(
			<SubscriptionLoadMore isLoading={false} onLoadMore={() => undefined} />,
		);
		expect(loadMore).toContain("Load more");
	});

	test("labels Included, Card, and Wallet from the generated funding source", () => {
		if (!subscriptionPaymentSourceLabel) {
			throw new Error("Subscription payment source helper was not loaded");
		}
		expect(subscriptionPaymentSourceLabel(null)).toBe("Included");
		expect(subscriptionPaymentSourceLabel("stripe")).toBe("Card");
		expect(subscriptionPaymentSourceLabel("wallet")).toBe("Wallet");
	});
});
