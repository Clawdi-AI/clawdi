import { describe, expect, test } from "bun:test";
import {
	type CheckoutReturnNavigationTarget,
	checkoutReturnHasNavigationOwner,
	checkoutReturnMarker,
	checkoutReturnNavigationResult,
	checkoutReturnNavigationTarget,
	checkoutReturnWasCanceled,
	checkoutSearchAfterConsume,
} from "@/hosted/billing/checkout-return";

describe("checkout return navigation", () => {
	test("prefers the URL-decoded deploy request lineage and awaits its navigation owner", async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const targets: CheckoutReturnNavigationTarget[] = [];
		let settled = false;
		const ownership = checkoutReturnHasNavigationOwner(
			"?session_id=cs_return&deploy_request_id=checkout%2Fstable%3Akey&deployment_id=hdep_legacy",
			async (target) => {
				targets.push(target);
				await gate;
				return true;
			},
		).then((owned) => {
			settled = true;
			return owned;
		});

		await Promise.resolve();
		expect(targets).toEqual([{ kind: "deploy_request", deployRequestId: "checkout/stable:key" }]);
		expect(settled).toBe(false);
		release();
		expect(await ownership).toBe(true);
	});

	test("accepts deployment callback targets without treating them as Agent identity", () => {
		expect(checkoutReturnNavigationTarget("?deployment_id=hdep_current")).toEqual({
			kind: "deployment",
			deploymentId: "hdep_current",
		});
		expect(checkoutReturnNavigationTarget("?upgrade_deployment_id=hdep_upgrade")).toEqual({
			kind: "deployment",
			deploymentId: "hdep_upgrade",
		});
	});

	test("leaves cleanup to the handler when the owner does not replace-navigate", async () => {
		expect(await checkoutReturnHasNavigationOwner("?deployment_id=hdep_current", () => false)).toBe(
			false,
		);
	});

	test("preserves a handled terminal result without claiming navigation ownership", async () => {
		expect(
			await checkoutReturnNavigationResult("?deploy_request_id=checkout-rejected", () => "handled"),
		).toBe("handled");
		expect(
			await checkoutReturnHasNavigationOwner("?deploy_request_id=checkout-rejected", () =>
				Promise.resolve("handled"),
			),
		).toBe(false);
	});

	test("keeps only the billing destination after consuming callback state", () => {
		expect(
			checkoutSearchAfterConsume({
				settings: "billing-plan",
				deployment_id: "hdep_current",
				session_id: "cs_return",
				checkout: "success",
				future: "discarded",
			}),
		).toEqual({ settings: "billing-plan" });
		expect(checkoutSearchAfterConsume({ deployment_id: "hdep_current" })).toEqual({});
	});

	test("keeps cancellation non-navigating even when lineage is present", async () => {
		let navigationCalls = 0;
		const owned = await checkoutReturnHasNavigationOwner(
			"?deploy_request_id=checkout-key&checkout=cancel",
			() => {
				navigationCalls += 1;
				return true;
			},
		);

		expect(owned).toBe(false);
		expect(navigationCalls).toBe(0);
		expect(checkoutReturnWasCanceled("?checkout=cancel")).toBe(true);
		expect(checkoutReturnMarker("?checkout=cancel")).toBe("checkout=cancel");
	});

	test("does not treat passive checkout success copy as a refresh marker", () => {
		expect(checkoutReturnWasCanceled("?checkout=success")).toBe(false);
		expect(checkoutReturnMarker("?checkout=success")).toBeNull();
	});
});
