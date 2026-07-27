import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderUsabilityBadge } from "@/hosted/v2/ai-providers/ai-providers-ui";

const providerPageSource = readFileSync(
	new URL("./ai-providers-page.tsx", import.meta.url),
	"utf8",
);

describe("ProviderUsabilityBadge", () => {
	test("badges an unfinished provider as needing setup, never connected", () => {
		const markup = renderToStaticMarkup(createElement(ProviderUsabilityBadge, { usable: false }));

		expect(markup).toContain("Needs setup");
		expect(markup).not.toContain("Connected");
		expect(markup).toContain('data-status="warning"');
	});

	test("uses the backend state for the list badge and recovery action", () => {
		expect(providerPageSource).toContain("<ProviderUsabilityBadge usable={provider.usable} />");
		expect(providerPageSource).toContain('provider.usable ? "Edit" : "Finish setup"');
		expect(providerPageSource).toContain("<RemoveProviderAction provider={provider}");
	});

	test("badges a credential-backed provider as saved without claiming connectivity", () => {
		const markup = renderToStaticMarkup(createElement(ProviderUsabilityBadge, { usable: true }));

		expect(markup).toContain("Saved");
		expect(markup).not.toContain("Connected");
		expect(markup).toContain('data-status="success"');
	});
});
