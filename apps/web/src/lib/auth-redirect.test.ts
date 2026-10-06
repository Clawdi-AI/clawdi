import { describe, expect, it } from "bun:test";
import { sanitizeAuthRedirectPath, signInActionHref } from "./auth-redirect";

describe("auth action destinations", () => {
	it("preserves the entire safe intention in the dedicated login fallback", () => {
		const path = "/share/project?deploy_profile=sui&trial=off#invitation";
		expect(sanitizeAuthRedirectPath(path)).toBe(path);
		expect(
			new URL(signInActionHref(path), "https://cloud.test").searchParams.get("redirect_url"),
		).toBe(path);
	});
	it("rejects external, protocol-relative and malformed intentions", () => {
		for (const path of [
			"https://evil.test/",
			"//evil.test/",
			"/\\evil.test/",
			"/share\n/secret",
			"javascript:alert(1)",
		])
			expect(sanitizeAuthRedirectPath(path)).toBe("/");
	});
});
