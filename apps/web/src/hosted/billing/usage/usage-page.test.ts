import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { HostedUsageSummary } from "@/hosted/billing/contracts";

type UsageSummaryView = typeof import("@/hosted/billing/usage/usage-page").UsageSummaryView;

let usageSummaryView: UsageSummaryView | null = null;

beforeAll(async () => {
	process.env.VITE_CLAWDI_API_URL = "http://localhost:8000";
	process.env.VITE_CLAWDI_DEPLOY_API_URL = "http://localhost:50021";
	process.env.VITE_CLERK_PUBLISHABLE_KEY = "pk_test_dummy";
	usageSummaryView = (await import("@/hosted/billing/usage/usage-page")).UsageSummaryView;
});

const PERIOD = {
	period_start: "2026-07-01T00:00:00Z",
	period_end: "2026-08-01T00:00:00Z",
} as const;

function renderUsage(usage: HostedUsageSummary): string {
	if (!usageSummaryView) throw new Error("usage page was not loaded");
	return renderToStaticMarkup(
		createElement(usageSummaryView, {
			usage,
			providers: [],
			managedModels: [],
			isRetrying: false,
			onRetry: () => undefined,
		}),
	);
}

describe("usage availability rendering", () => {
	test("wires the retry control to the usage query refetch", () => {
		const source = readFileSync(new URL("./usage-page.tsx", import.meta.url), "utf8");

		expect(source).toContain("<UsageRetryButton");
		expect(source).toContain("const [manualRetrying, setManualRetrying] = useState(false);");
		expect(source).toContain("await usage.refetch();");
		expect(source).toContain("isRetrying={manualRetrying}");
		expect(source).not.toContain("isRetrying={usage.isFetching}");
	});

	test("renders a real complete zero as no usage", () => {
		const markup = renderUsage({
			...PERIOD,
			availability: "complete",
			unavailable_sections: [],
			total_usd: "0.0000",
			total_requests: 0,
			by_agent: [],
			by_model: [],
			by_day: [],
		});

		expect(markup).toContain("No usage yet");
		expect(markup).not.toContain("can’t load your usage");
	});

	test("renders an unavailable response without fabricating a zero", () => {
		const markup = renderUsage({
			...PERIOD,
			availability: "unavailable",
			unavailable_sections: ["totals", "by_agent", "by_model", "by_day"],
			total_usd: null,
			total_requests: null,
			by_agent: [],
			by_model: [],
			by_day: [],
		});

		expect(markup).toContain("We can’t load your usage right now");
		expect(markup).toContain("Retry");
		expect(markup).not.toContain("No usage yet");
		expect(markup).not.toContain("$0.00");
		expect(markup).not.toContain("Clawdi AI spend in window");
	});

	test("treats a missing by_agent field from an older backend as unavailable", () => {
		const markup = renderUsage({
			...PERIOD,
			availability: "complete",
			unavailable_sections: [],
			total_usd: "12.50",
			total_requests: 37,
			by_model: [
				{
					model: "model-read-successfully",
					provider: null,
					amount_usd: "12.50",
					requests: 37,
				},
			],
			by_day: [],
		});

		expect(markup).toContain("Agent breakdown unavailable");
		expect(markup).toContain("Retry");
		expect(markup).toContain("$12.50");
		expect(markup).toContain("37");
		expect(markup).toContain("model-read-successfully");
		expect(markup).not.toContain("Daily usage");
	});

	test("keeps agent attribution visible when totals and model data are unavailable", () => {
		const markup = renderUsage({
			...PERIOD,
			availability: "partial",
			unavailable_sections: ["totals", "by_model"],
			total_usd: null,
			total_requests: null,
			by_agent: [
				{
					agent_id: "hdep_support",
					agent_name: "openclaw-support",
					amount_usd: "9.25",
					requests: 12,
				},
			],
			by_model: [],
			by_day: [{ date: "2026-07-20", amount_usd: "9.25" }],
		});

		expect(markup).toContain("Usage totals unavailable");
		expect(markup).toContain("Model breakdown unavailable");
		expect(markup).toContain("support");
		expect(markup).toContain("hdep_support");
		expect(markup).toContain("$9.25");
		expect(markup).not.toContain("No usage yet");
	});

	test("shows explicit unattributed usage and sorts both breakdowns by spend", () => {
		const markup = renderUsage({
			...PERIOD,
			availability: "complete",
			unavailable_sections: [],
			total_usd: "12.50",
			total_requests: 37,
			by_agent: [
				{ agent_id: null, agent_name: null, amount_usd: "2.50", requests: 7 },
				{
					agent_id: "hdep_research",
					agent_name: "openclaw-research",
					amount_usd: "10.00",
					requests: 30,
				},
			],
			by_model: [
				{
					model: "smaller-model",
					provider: null,
					amount_usd: "2.50",
					requests: 7,
				},
				{
					model: "larger-model",
					provider: null,
					amount_usd: "10.00",
					requests: 30,
				},
			],
			by_day: [],
		});

		expect(markup).toContain("Unattributed");
		expect(markup).toContain("Deleted or unmapped agent usage");
		expect(markup.indexOf("research")).toBeLessThan(markup.indexOf("Unattributed"));
		expect(markup.indexOf("larger-model")).toBeLessThan(markup.indexOf("smaller-model"));
	});
});
