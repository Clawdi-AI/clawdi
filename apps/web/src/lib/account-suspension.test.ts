import { describe, expect, test } from "bun:test";
import { createAccountSuspensionStore, isAccountSuspendedProblem } from "./account-suspension";

const problem = {
	type: "urn:clawdi:problem:account-suspended",
	title: "Account suspended",
	status: 401,
	detail: "Account is suspended",
	code: "account_suspended",
};

describe("account suspension contract", () => {
	test("recognizes only the stable typed problem", () => {
		expect(isAccountSuspendedProblem(problem)).toBe(true);
		expect(isAccountSuspendedProblem({ ...problem, code: "invalid_credentials" })).toBe(false);
		expect(isAccountSuspendedProblem({ detail: "Account is suspended" })).toBe(false);
	});

	test("a late suspension response affects only its originating account scope", async () => {
		const store = createAccountSuspensionStore();
		const nextAccount = createAccountSuspensionStore();
		const response = new Response(JSON.stringify(problem), {
			status: 401,
			headers: { "content-type": "application/problem+json" },
		});

		expect(await store.observeResponse(response)).toBe(true);
		expect(store.getSnapshot()).toBe(true);
		expect(nextAccount.getSnapshot()).toBe(false);
	});

	test("ordinary authentication failures do not look suspended", async () => {
		const store = createAccountSuspensionStore();
		const nextAccount = createAccountSuspensionStore();
		const response = new Response(JSON.stringify({ detail: "Invalid credentials" }), {
			status: 401,
			headers: { "content-type": "application/json" },
		});

		expect(await store.observeResponse(response)).toBe(false);
		expect(store.getSnapshot()).toBe(false);
		expect(nextAccount.getSnapshot()).toBe(false);
	});
});
