import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthBadge, ProviderUsabilityBadge } from "@/hosted/v2/ai-providers/ai-providers-ui";

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

	test("requires a credential before presenting a provider as hosted-usable", () => {
		expect(providerPageSource).toContain(
			'const hostedUsable = provider.usable && provider.auth.type !== "none";',
		);
		expect(providerPageSource).toContain("<ProviderUsabilityBadge usable={hostedUsable} />");
		expect(providerPageSource).toContain('hostedUsable ? "Edit" : "Finish setup"');
		expect(providerPageSource).toContain("<RemoveProviderAction provider={provider}");
	});

	test("labels legacy no-credential records without offering No auth", () => {
		const markup = renderToStaticMarkup(createElement(AuthBadge, { auth: { type: "none" } }));

		expect(markup).toContain("Legacy · no credential");
		expect(markup).not.toContain("No auth");
	});

	test("badges a credential-backed provider as saved without claiming connectivity", () => {
		const markup = renderToStaticMarkup(createElement(ProviderUsabilityBadge, { usable: true }));

		expect(markup).toContain("Saved");
		expect(markup).not.toContain("Connected");
		expect(markup).toContain('data-status="success"');
	});
});
