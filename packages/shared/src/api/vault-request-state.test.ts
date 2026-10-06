import { expect, test } from "bun:test";
import { buildVaultSecretRequest, safeVaultRequestUrl } from "./vault-request-state";

const identity = { id: "vault-id", slug: "vault-slug" };
test("secret request preserves exact case and validates names and expiry before transmission", () => {
	expect(
		buildVaultSecretRequest(identity, "project-id", " api ", "Token, token\nclient.id", 3600),
	).toEqual({
		vault_id: "vault-id",
		slug: "vault-slug",
		project_id: "project-id",
		section: "api",
		fields: ["Token", "token", "client.id"],
		expires_in_seconds: 3600,
	});
	for (const names of [
		"",
		"A,A",
		"A, A",
		"A=value",
		"bad field",
		"a".repeat(201),
		Array.from({ length: 33 }, (_, i) => `K${i}`).join(","),
	]) {
		expect(() => buildVaultSecretRequest(identity, "project-id", "", names, 3600)).toThrow();
	}
	for (const expiry of [299, 86401, 300.5, Number.NaN])
		expect(() => buildVaultSecretRequest(identity, "project-id", "", "KEY", expiry)).toThrow();
	expect(() =>
		buildVaultSecretRequest(identity, "project-id", "bad/section", "KEY", 3600),
	).toThrow();
});

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
