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

type CheckoutReturnAttempt = {
	marker: string;
	pathname: string;
	completion: Promise<unknown>;
	settled: boolean;
};

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
	const pathname = useLocation({ select: (location) => location.pathname });
	const searchStr = useLocation({ select: (location) => location.searchStr });
	const marker = checkoutReturnMarker(searchStr);
	// Reuse an in-flight refresh across React's development effect replay, but
	// never reacquire it after the marker or owning pathname has changed.
	const attemptRef = useRef<CheckoutReturnAttempt | null>(null);
	const copyRef = useRef(onCancelCopy);
	const navigateRef = useRef(onNavigate);
	copyRef.current = onCancelCopy;
	navigateRef.current = onNavigate;

	useEffect(() => {
		const currentAttempt = attemptRef.current;
		if (!marker) {
			if (currentAttempt) currentAttempt.settled = true;
			return;
		}
		let attempt: CheckoutReturnAttempt;
		if (currentAttempt?.marker === marker) {
			if (currentAttempt.pathname !== pathname) {
				currentAttempt.settled = true;
				return;
			}
			if (currentAttempt.settled) return;
			attempt = currentAttempt;
		} else {
			attempt = {
				marker,
				pathname,
				completion: refreshCheckoutReturn(),
				settled: false,
			};
			attemptRef.current = attempt;
		}
		let ownsReturnLocation = true;
		void attempt.completion
			.then(() => {
				if (!ownsReturnLocation || attemptRef.current !== attempt || attempt.settled) return;
				attempt.settled = true;
				if (checkoutReturnWasCanceled(marker)) {
					toast.message("Checkout canceled", { description: copyRef.current });
					return;
				}
				const deploymentId = checkoutReturnDeploymentId(marker);
				if (deploymentId && navigateRef.current(deploymentId) !== false) return;
				toast.message("Checkout status refreshed", {
					description: "We checked your agents, subscription, and wallet.",
				});
			})
			.catch(() => {
				if (!ownsReturnLocation || attemptRef.current !== attempt || attempt.settled) return;
				attempt.settled = true;
				toast.error("Couldn’t refresh checkout status", {
					description: "Refresh the page to check your agents, subscription, and wallet.",
				});
			});
		return () => {
			ownsReturnLocation = false;
		};
	}, [marker, pathname, refreshCheckoutReturn]);
}
