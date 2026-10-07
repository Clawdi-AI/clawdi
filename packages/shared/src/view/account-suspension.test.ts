import { describe, expect, test } from "bun:test";
import { createCloudApiClient } from "../api";
import {
	createAccountSuspensionStore,
	isAccountSuspendedProblem,
	observeAccountSuspension,
} from "./account-suspension";

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

describe("account suspension observation", () => {
	test("any account read through the observed fetch suspends only on the typed problem", async () => {
		const suspended = createAccountSuspensionStore();
		const client = createCloudApiClient({
			baseUrl: "https://api.example.test",
			getToken: async () => "token",
			fetch: observeAccountSuspension(suspended, async () =>
				Response.json(problem, { status: 401 }),
			),
		});
		await expect(client.listAgents()).rejects.toMatchObject({
			status: 401,
			code: "account_suspended",
		});
		expect(suspended.getSnapshot()).toBe(true);

		const expired = createAccountSuspensionStore();
		const other = createCloudApiClient({
			baseUrl: "https://api.example.test",
			getToken: async () => "token",
			fetch: observeAccountSuspension(expired, async () =>
				Response.json({ detail: "Invalid credentials" }, { status: 401 }),
			),
		});
		await expect(other.listAgents()).rejects.toMatchObject({ status: 401 });
		expect(expired.getSnapshot()).toBe(false);
	});
});
