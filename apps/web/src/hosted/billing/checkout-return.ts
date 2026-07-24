"use client";

import { useLocation } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useCheckoutReturnRefresh } from "@/hosted/billing/hooks";

const DEPLOYMENT_PARAMS = ["deployment_id", "upgrade_deployment_id"] as const;
const MARKER_PARAMS = [
	"session_id",
	"checkout_session_id",
	...DEPLOYMENT_PARAMS,
	"mockCheckout",
] as const;

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

export function useCheckoutReturnHandler({
	onCancelCopy,
	onNavigate,
}: {
	onCancelCopy: string;
	/** Return false to keep the current page and show the refresh toast. */
	onNavigate: (deploymentId: string) => false | undefined;
}): void {
	const refreshCheckoutReturn = useCheckoutReturnRefresh();
	const searchStr = useLocation({ select: (location) => location.searchStr });
	const handledMarkerRef = useRef<string | null>(null);

	useEffect(() => {
		const marker = checkoutReturnMarker(searchStr);
		if (!marker || handledMarkerRef.current === marker) return;
		handledMarkerRef.current = marker;
		void refreshCheckoutReturn()
			.then(() => {
				if (checkoutReturnWasCanceled(searchStr)) {
					toast.message("Checkout canceled", { description: onCancelCopy });
					return;
				}
				const deploymentId = checkoutReturnDeploymentId(searchStr);
				if (deploymentId && onNavigate(deploymentId) !== false) return;
				toast.message("Checkout status refreshed", {
					description: "We checked your deployments, subscription, and wallet.",
				});
			})
			.catch(() => {
				toast.error("Couldn’t refresh checkout status", {
					description: "Refresh the page to check your deployments, subscription, and wallet.",
				});
			});
	}, [onCancelCopy, onNavigate, refreshCheckoutReturn, searchStr]);
}
