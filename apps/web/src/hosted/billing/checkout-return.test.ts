import { describe, expect, test } from "bun:test";
import {
	type CheckoutReturnNavigationTarget,
	checkoutReturnHasNavigationOwner,
	checkoutReturnMarker,
	checkoutReturnNavigationTarget,
	checkoutReturnWasCanceled,
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

	test("preserves legacy deployment return targets", () => {
		expect(checkoutReturnNavigationTarget("?deployment_id=hdep_current")).toEqual({
			kind: "deployment",
			deploymentId: "hdep_current",
		});
		expect(checkoutReturnNavigationTarget("?upgrade_deployment_id=hdep_upgrade")).toEqual({
			kind: "deployment",
			deploymentId: "hdep_upgrade",
		});
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
