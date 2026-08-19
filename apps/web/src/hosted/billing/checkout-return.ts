"use client";

import { useLocation, useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useCheckoutReturnRefresh } from "@/hosted/billing/hooks";

const DEPLOYMENT_PARAMS = ["deployment_id", "upgrade_deployment_id"] as const;
const MARKER_PARAMS = [
	"session_id",
	"checkout_session_id",
	"deploy_request_id",
	...DEPLOYMENT_PARAMS,
	"mockCheckout",
] as const;

export type CheckoutReturnNavigationTarget =
	| { kind: "deploy_request"; deployRequestId: string }
	| { kind: "deployment"; agentId?: string | null; deploymentId: string };

export function checkoutReturnWasCanceled(searchStr: string): boolean {
	return new URLSearchParams(searchStr).get("checkout") === "cancel";
}

export function checkoutReturnMarker(searchStr: string): string | null {
	const params = new URLSearchParams(searchStr);
	const values = MARKER_PARAMS.flatMap((key) => {
		const value = params.get(key);
		return value ? [`${key}=${value}`] : [];
	});
	if (checkoutReturnWasCanceled(searchStr)) values.push("checkout=cancel");
	return values.length > 0 ? values.join("&") : null;
}

export function checkoutReturnDeploymentId(searchStr: string): string | null {
	const params = new URLSearchParams(searchStr);
	for (const key of DEPLOYMENT_PARAMS) {
		const value = params.get(key);
		if (value) return value;
	}
	return null;
}

export function checkoutReturnNavigationTarget(
	searchStr: string,
): CheckoutReturnNavigationTarget | null {
	const params = new URLSearchParams(searchStr);
	const deployRequestId = params.get("deploy_request_id")?.trim();
	if (deployRequestId) return { kind: "deploy_request", deployRequestId };
	const deploymentId = checkoutReturnDeploymentId(searchStr);
	return deploymentId ? { kind: "deployment", deploymentId } : null;
}

type CheckoutReturnNavigationOwner = (
	target: CheckoutReturnNavigationTarget,
) => boolean | Promise<boolean>;

export async function checkoutReturnHasNavigationOwner(
	searchStr: string,
	onNavigate: CheckoutReturnNavigationOwner,
): Promise<boolean> {
	if (checkoutReturnWasCanceled(searchStr)) return false;
	const target = checkoutReturnNavigationTarget(searchStr);
	return target !== null && (await onNavigate(target));
}

export function checkoutSearchAfterConsume(
	search: Record<string, unknown>,
): Record<string, unknown> {
	return search.settings === "billing-plan" ? { settings: "billing-plan" } : {};
}

export function useCheckoutReturnHandler({
	onCancelCopy,
	onNavigate,
}: {
	onCancelCopy: string;
	/** Return true when the callback owns navigation and deployment hydration. */
	onNavigate: CheckoutReturnNavigationOwner;
}): void {
	const refreshCheckoutReturn = useCheckoutReturnRefresh();
	const router = useRouter();
	const searchStr = useLocation({ select: (location) => location.searchStr });
	const handledMarkerRef = useRef<string | null>(null);

	useEffect(() => {
		const marker = checkoutReturnMarker(searchStr);
		if (!marker || handledMarkerRef.current === marker) return;
		handledMarkerRef.current = marker;
		const canceled = checkoutReturnWasCanceled(searchStr);
		void checkoutReturnHasNavigationOwner(searchStr, onNavigate)
			.then(async (owned) => {
				let refreshFailed = false;
				try {
					await refreshCheckoutReturn(owned ? { includeDeployments: false } : undefined);
				} catch {
					refreshFailed = true;
					toast.error("Couldn’t refresh checkout status", {
						description: owned
							? "Refresh the page to check your subscription and wallet."
							: "Refresh the page to check your agents, subscription, and wallet.",
					});
				}
				if (owned) return;
				await router.navigate({
					to: ".",
					search: checkoutSearchAfterConsume,
					hash: true,
					replace: true,
					resetScroll: false,
				});
				if (refreshFailed) return;
				toast.message(canceled ? "Checkout canceled" : "Checkout status refreshed", {
					description: canceled
						? onCancelCopy
						: "We checked your agents, subscription, and wallet.",
				});
			})
			.catch(() => {
				toast.error("Couldn’t open the checkout result", {
					description: "Refresh the page to try again.",
				});
			});
	}, [onCancelCopy, onNavigate, refreshCheckoutReturn, router, searchStr]);
}
