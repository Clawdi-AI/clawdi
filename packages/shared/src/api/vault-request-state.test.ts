import { expect, test } from "bun:test";
import { safeVaultRequestUrl, vaultRequestsRefetchInterval } from "./vault-request-state";

test("request sharing accepts only HTTPS fragment capability links", () => {
	const token = `v2_${"a".repeat(43)}`;
	const link = `https://example.com/vault-request#${token}`;
	expect(safeVaultRequestUrl(link)).toBe(link);
	for (const invalid of [
		link.replace("https:", "http:"),
		link.replace("example.com", "user:pass@example.com"),
		link.replace("#", "?token="),
		link.replace("vault-request", "another-path"),
		`${link}x`,
		"javascript:alert(1)",
	])
		expect(safeVaultRequestUrl(invalid)).toBeNull();
});

test("secret requests keep polling until no row awaits input", () => {
	type Row = NonNullable<Parameters<typeof vaultRequestsRefetchInterval>[0]>[number];
	for (const [rows, expected] of [
		[undefined, false],
		[[], false],
		[[{ status: "pending" }], 10_000],
		[[{ status: "supplied" }, { status: "pending" }], 10_000],
		[[{ status: "supplied" }, { status: "expired" }, { status: "conflict" }], false],
	] satisfies [Row[] | undefined, number | false][]) {
		expect(vaultRequestsRefetchInterval(rows)).toBe(expected);
	}
});
