import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { BillingApiError } from "@/hosted/billing/errors";
import { billingKeys } from "@/hosted/billing/query-keys";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";
import {
	hermesOidcAuthorityIdentity,
	primeHermesOidcBrowserSession,
	primeHermesOidcBrowserSessionWithRefetch,
} from "./hermes-oidc-browser-session";

const originalFetch = globalThis.fetch;
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
afterEach(() => {
	globalThis.fetch = originalFetch;
	queryClient.clear();
});

function capturingFetch(
	calls: Array<[string | URL | Request, RequestInit | undefined]>,
	statuses: readonly number[] = [204],
): typeof fetch {
	return Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			calls.push([input, init]);
			const status = statuses[calls.length - 1];
			if (status === undefined) throw new Error("Unexpected browser session request.");
			return new Response(null, { status });
		},
		{ preconnect: originalFetch.preconnect },
	);
}

describe("primeHermesOidcBrowserSession", () => {
	test("binds mounted authority to the stable OIDC revision", () => {
		const current = hermesOidcAuthorityIdentity(
			"user_test",
			"hdep_test",
			"https://hermes.example/",
			"https://api.clawdi.ai/v2/deployments/hdep_test/hermes-oidc/session",
			7,
		);
		expect(
			hermesOidcAuthorityIdentity(
				"user_test",
				"hdep_test",
				"https://hermes.example/",
				"https://api.clawdi.ai/v2/deployments/hdep_test/hermes-oidc/session",
				7,
			),
		).toBe(current);
		expect(
			hermesOidcAuthorityIdentity(
				"user_test",
				"hdep_test",
				"https://hermes.example/",
				"https://api.clawdi.ai/v2/deployments/hdep_test/hermes-oidc/session",
				8,
			),
		).not.toBe(current);
	});
	test("posts the Clerk bearer with the exact deployment version", async () => {
		const calls: Array<[string | URL | Request, RequestInit | undefined]> = [];
		globalThis.fetch = capturingFetch(calls);
		await primeHermesOidcBrowserSession(
			"https://api.clawdi.ai/v2/deployments/hdep_test/hermes-oidc/session",
			"hdep_test",
			"https://api.clawdi.ai",
			"clerk-token",
			"rv-test",
			new AbortController().signal,
		);
		expect(calls).toHaveLength(1);
		const call = calls[0];
		expect(call).toBeDefined();
		if (!call) throw new Error("Expected one fetch call.");
		const [url, init] = call;
		expect(String(url)).toBe("https://api.clawdi.ai/v2/deployments/hdep_test/hermes-oidc/session");
		expect(init?.credentials).toBe("include");
		expect(init?.headers).toEqual({
			Authorization: "Bearer clerk-token",
			"If-Match": '"rv-test"',
		});
	});

	test("rejects a session URL on another origin before sending the bearer", async () => {
		const calls: Array<[string | URL | Request, RequestInit | undefined]> = [];
		globalThis.fetch = capturingFetch(calls);
		await expect(
			primeHermesOidcBrowserSession(
				"https://attacker.example/v2/deployments/hdep_test/hermes-oidc/session",
				"hdep_test",
				"https://api.clawdi.ai",
				"clerk-token",
				"rv-test",
				new AbortController().signal,
			),
		).rejects.toThrow("Invalid Hermes browser session endpoint.");
		expect(calls).toHaveLength(0);
	});

	test("rejects a session URL for another deployment before fetching", async () => {
		const calls: Array<[string | URL | Request, RequestInit | undefined]> = [];
		globalThis.fetch = capturingFetch(calls);
		await expect(
			primeHermesOidcBrowserSession(
				"https://api.clawdi.ai/v2/deployments/hdep_other/hermes-oidc/session",
				"hdep_test",
				"https://api.clawdi.ai",
				"clerk-token",
				"rv-test",
				new AbortController().signal,
			),
		).rejects.toThrow("Invalid Hermes browser session endpoint.");
		expect(calls).toHaveLength(0);
	});
});

function recoveryFixture(statuses: readonly number[]) {
	const staleDeployment = hostedDeploymentFixture({
		id: "hdep_test",
		runtime: "hermes",
		resourceVersion: "rv-stale",
	});
	const freshDeployment = hostedDeploymentFixture({
		id: "hdep_test",
		runtime: "hermes",
		resourceVersion: "rv-fresh",
	});
	const unrelatedDeployment = hostedDeploymentFixture({ id: "hdep_other" });
	queryClient.setQueryData(billingKeys.deployments, [staleDeployment, unrelatedDeployment]);
	const getDeployment = mock(async (_id: string) => freshDeployment);
	const calls: Array<[string | URL | Request, RequestInit | undefined]> = [];
	globalThis.fetch = capturingFetch(calls, statuses);
	return {
		calls,
		freshDeployment,
		unrelatedDeployment,
		getDeployment,
		prime: () =>
			primeHermesOidcBrowserSessionWithRefetch({
				url: "https://api.clawdi.ai/v2/deployments/hdep_test/hermes-oidc/session",
				deploymentId: "hdep_test",
				trustedApiOrigin: "https://api.clawdi.ai",
				token: "clerk-token",
				resourceVersion: staleDeployment.resource.metadata.resourceVersion,
				signal: new AbortController().signal,
				getDeployment,
				queryClient,
			}),
	};
}

describe("primeHermesOidcBrowserSessionWithRefetch", () => {
	test("refetches on 412, primes with the fresh version and updates the deployment cache", async () => {
		const { calls, freshDeployment, unrelatedDeployment, getDeployment, prime } = recoveryFixture([
			412, 204,
		]);
		await expect(prime()).resolves.toBe("rv-fresh");
		expect(calls).toHaveLength(2);
		expect(calls.map(([, init]) => init?.headers)).toEqual([
			{ Authorization: "Bearer clerk-token", "If-Match": '"rv-stale"' },
			{ Authorization: "Bearer clerk-token", "If-Match": '"rv-fresh"' },
		]);
		expect(getDeployment).toHaveBeenCalledTimes(1);
		expect(getDeployment).toHaveBeenCalledWith("hdep_test");
		expect(queryClient.getQueryData(billingKeys.deployments)).toEqual([
			freshDeployment,
			unrelatedDeployment,
		]);
	});

	test("propagates a second 412 after exactly one refetch and one retry", async () => {
		const { calls, getDeployment, prime } = recoveryFixture([412, 412]);
		const error = await prime().catch((error: unknown) => error);
		expect(error).toBeInstanceOf(BillingApiError);
		expect(error).toMatchObject({ status: 412 });
		expect(calls).toHaveLength(2);
		expect(getDeployment).toHaveBeenCalledTimes(1);
	});

	test("propagates other HTTP failures without refetching or retrying", async () => {
		const { calls, getDeployment, prime } = recoveryFixture([503]);
		const error = await prime().catch((error: unknown) => error);
		expect(error).toBeInstanceOf(BillingApiError);
		expect(error).toMatchObject({ status: 503 });
		expect(calls).toHaveLength(1);
		expect(getDeployment).not.toHaveBeenCalled();
	});
});
