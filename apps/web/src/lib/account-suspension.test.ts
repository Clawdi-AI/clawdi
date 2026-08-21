import { afterEach, describe, expect, test } from "bun:test";
import {
	clearAccountSuspension,
	getAccountSuspendedSnapshot,
	isAccountSuspendedProblem,
	observeAccountSuspensionResponse,
} from "./account-suspension";

const problem = {
	type: "urn:clawdi:problem:account-suspended",
	title: "Account suspended",
	status: 401,
	detail: "Account is suspended",
	code: "account_suspended",
};

afterEach(() => clearAccountSuspension());

describe("account suspension contract", () => {
	test("recognizes only the stable typed problem", () => {
		expect(isAccountSuspendedProblem(problem)).toBe(true);
		expect(isAccountSuspendedProblem({ ...problem, code: "invalid_credentials" })).toBe(false);
		expect(isAccountSuspendedProblem({ detail: "Account is suspended" })).toBe(false);
	});

	test("a suspension response switches the global access boundary", async () => {
		const response = new Response(JSON.stringify(problem), {
			status: 401,
			headers: { "content-type": "application/problem+json" },
		});

		expect(await observeAccountSuspensionResponse(response)).toBe(true);
		expect(getAccountSuspendedSnapshot()).toBe(true);
	});

	test("ordinary authentication failures do not look suspended", async () => {
		const response = new Response(JSON.stringify({ detail: "Invalid credentials" }), {
			status: 401,
			headers: { "content-type": "application/json" },
		});

		expect(await observeAccountSuspensionResponse(response)).toBe(false);
		expect(getAccountSuspendedSnapshot()).toBe(false);
	});
});
