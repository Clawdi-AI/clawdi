import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthLoadScreen } from "./auth-provider";

describe("AuthLoadScreen", () => {
	test("shows an immediate branded loading state without claiming auth is ready", () => {
		const markup = renderToStaticMarkup(createElement(AuthLoadScreen));

		expect(markup).toContain('alt="Clawdi"');
		expect(markup).toContain('role="status"');
		expect(markup).toContain("Connecting to secure sign-in");
		expect(markup).not.toContain("Secure sign-in did not load");
	});

	test("shows an actionable failure with a non-reload exit", () => {
		const markup = renderToStaticMarkup(createElement(AuthLoadScreen, { failed: true }));

		expect(markup).toContain("Secure sign-in did not load");
		expect(markup).toContain("No sign-in attempt was submitted");
		expect(markup).toContain("Try again");
		expect(markup).toContain('href="https://clawdi.ai"');
	});
});
