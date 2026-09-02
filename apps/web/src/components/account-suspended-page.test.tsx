import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountSuspendedPage } from "./account-suspended-page";

describe("AccountSuspendedPage", () => {
	test("explains the access loss and preserves support and sign-out exits", () => {
		const markup = renderToStaticMarkup(
			createElement(AccountSuspendedPage, { onSignOut: () => undefined }),
		);

		expect(markup).toContain("Account suspended");
		expect(markup).toContain(
			"Your account has been suspended due to a violation of the Clawdi User Agreement.",
		);
		expect(markup).toContain('href="mailto:support@clawdi.ai"');
		expect(markup).toContain("Sign out");
		expect(markup).not.toContain("account_suspended");
		expect(markup).not.toContain("reason");
	});
});
