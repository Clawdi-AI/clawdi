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
			unavailable_sections: ["totals", "by_model", "by_day"],
			total_usd: null,
			total_requests: null,
			by_model: [],
			by_day: [],
		});

		expect(markup).toContain("We can’t load your usage right now");
		expect(markup).toContain("Retry");
		expect(markup).not.toContain("No usage yet");
		expect(markup).not.toContain("$0.00");
		expect(markup).not.toContain("Clawdi AI spend in window");
	});

	test("names a missing daily section while preserving read totals and model usage", () => {
		const markup = renderUsage({
			...PERIOD,
			availability: "partial",
			unavailable_sections: ["by_day"],
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

		expect(markup).toContain("Some usage data is unavailable");
		expect(markup).toContain("the daily breakdown");
		expect(markup).toContain("Daily breakdown unavailable");
		expect(markup).toContain("$12.50");
		expect(markup).toContain("37");
		expect(markup).toContain("model-read-successfully");
	});

	test("hides missing totals and model values while preserving a read daily section", () => {
		const markup = renderUsage({
			...PERIOD,
			availability: "partial",
			unavailable_sections: ["totals", "by_model"],
			total_usd: null,
			total_requests: null,
			by_model: [],
			by_day: [{ date: "2026-07-20", amount_usd: "9.25" }],
		});

		expect(markup).toContain("spend and request totals and the model breakdown");
		expect(markup).toContain("Usage totals unavailable");
		expect(markup).toContain("Model breakdown unavailable");
		expect(markup).toContain("$9.25");
		expect(markup).not.toContain("Clawdi AI spend in window");
		expect(markup).not.toContain("Requests in window");
		expect(markup).not.toContain("No usage yet");
	});
});
