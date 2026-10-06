import { expect, test } from "bun:test";
import { importVaultSupplyRows, vaultRequestToken, vaultSupplyFields } from "./vault-supply-state";

test("supply keeps required case-sensitive names and rejects missing/duplicate/invalid values", () => {
	const required = { name: "Token", value: "one", required: true };
	const optional = { name: "token", value: "two", required: false };
	const rows = [required, optional];
	expect(vaultSupplyFields(rows, ["Token"])).toEqual({ Token: "one", token: "two" });
	for (const value of ["", "bad\0value", "a".repeat(65537)])
		expect(() => vaultSupplyFields([{ ...required, value }], ["Token"])).toThrow();
	expect(() => vaultSupplyFields([optional], ["Token"])).toThrow();
	expect(() => vaultSupplyFields([required, required], ["Token"])).toThrow();
	expect(
		vaultSupplyFields([{ ...required, value: "😀".repeat(65536) }], ["Token"]).Token,
	).toHaveLength(131072);
});
test("dotenv import preserves required fields, adds extras, and never partially applies invalid input", () => {
	const rows = [{ name: "Token", value: "old", required: true }];
	expect(importVaultSupplyRows(rows, 'Token="line1\\nline2"\nextra.key=value')).toEqual([
		{ name: "Token", value: "line1\nline2", required: true },
		{ name: "extra.key", value: "value", required: false },
	]);
	expect(() => importVaultSupplyRows(rows, "Token=one\nToken=two")).toThrow();
	expect(rows[0]?.value).toBe("old");
});
test("capability intake accepts only the approved fragment link shape", () => {
	const token = `v2_${"b".repeat(43)}`;
	expect(vaultRequestToken(` https://example.com/vault-request#${token} `)).toBe(token);
	expect(vaultRequestToken(`https://example.com/vault-request?token=${token}`)).toBeNull();
	expect(vaultRequestToken(token)).toBeNull();
});
