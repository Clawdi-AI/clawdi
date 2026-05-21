import { describe, expect, it } from "bun:test";
import { VaultReferenceResolveError } from "../../src/lib/secret-references";

describe("VaultReferenceResolveError", () => {
	it("explains shared Project backend drift for project_not_found responses", () => {
		const err = new VaultReferenceResolveError(404, {
			detail: { code: "project_not_found" },
		});

		expect(err.message).toContain("Vault resolve could not access the selected Project.");
		expect(err.message).toContain("shared Project");
		expect(err.message).toContain("update the Clawdi backend");
		expect(err.message).not.toContain("No vault value found");
	});
});
