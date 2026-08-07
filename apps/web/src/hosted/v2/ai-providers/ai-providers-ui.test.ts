import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthBadge, ProviderReadinessBadge } from "@/hosted/v2/ai-providers/ai-providers-ui";

const providerPageSource = readFileSync(
	new URL("./ai-providers-page.tsx", import.meta.url),
	"utf8",
);

describe("ProviderReadinessBadge", () => {
	test("badges an unfinished provider as needing setup, never connected", () => {
		const markup = renderToStaticMarkup(
			createElement(ProviderReadinessBadge, { deployable: false }),
		);

		expect(markup).toContain("Setup required");
		expect(markup).not.toContain("Connected");
		expect(markup).toContain('data-status="warning"');
	});

	test("requires hosted deployability before presenting a provider as ready", () => {
		expect(providerPageSource).toContain(
			'(provider.readiness?.deployable ?? provider.usable) && provider.auth.type !== "none"',
		);
		expect(providerPageSource).toContain("<ProviderReadinessBadge deployable={deployable} />");
		expect(providerPageSource).toContain('deployable ? "Edit" : "Finish setup"');
		expect(providerPageSource).toContain("<RemoveProviderAction provider={provider}");
	});

	test("labels legacy no-credential records without offering No auth", () => {
		const markup = renderToStaticMarkup(createElement(AuthBadge, { auth: { type: "none" } }));

		expect(markup).toContain("No credential");
		expect(markup).not.toContain("No auth");
	});

	test("badges a deployable provider as ready without claiming connectivity", () => {
		const markup = renderToStaticMarkup(
			createElement(ProviderReadinessBadge, { deployable: true }),
		);

		expect(markup).toContain("Ready");
		expect(markup).not.toContain("Connected");
		expect(markup).toContain('data-status="success"');
	});
});
