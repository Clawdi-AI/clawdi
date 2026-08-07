import { describe, expect, test } from "bun:test";
import { RUNTIME_AUTH_TOKEN_SECRET_REF, readRuntimeCredential } from "./auth-token";

describe("runtime credential reads", () => {
	test("resolves only the canonical manifest secret value", () => {
		expect(
			readRuntimeCredential({
				[RUNTIME_AUTH_TOKEN_SECRET_REF]: "runtime-token",
			}),
		).toBe("runtime-token");
		expect(readRuntimeCredential({})).toBeNull();
	});

	test("does not accept ambient or legacy secret aliases", () => {
		expect(
			readRuntimeCredential({
				CLAWDI_AUTH_TOKEN: "bare-alias",
				"env://CLAWDI_AUTH_TOKEN": "environment-alias",
			}),
		).toBeNull();
	});
});
