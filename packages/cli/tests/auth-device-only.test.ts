import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

test("CLI and Desktop have no authorization-code login or fixed loopback listener", () => {
	const root = join(import.meta.dir, "../../..");
	expect(existsSync(join(root, "packages/cli/src/lib/clerk-oauth-loopback.ts"))).toBe(false);
	for (const directory of ["packages/cli/src", "apps/desktop/src"]) {
		const source = join(root, directory);
		for (const path of new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: source, absolute: true })) {
			if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) continue;
			expect(readFileSync(path, "utf8")).not.toMatch(
				/127\.0\.0\.1:18473|clerk-oauth-loopback|fetchClerkOAuthPkceDiscovery|createClerkOAuthAuthorization|exchangeClerkOAuthCode/,
			);
		}
	}
});
