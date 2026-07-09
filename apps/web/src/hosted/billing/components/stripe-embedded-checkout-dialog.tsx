"use client";

import { EmbeddedCheckout, EmbeddedCheckoutProvider } from "@stripe/react-stripe-js";
import type { Stripe } from "@stripe/stripe-js";
import { AlertCircle, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { preflightEmbeddedCheckout, resetStripeCache } from "@/hosted/billing/stripe";
import { env } from "@/lib/env";

type StripeEmbeddedCheckoutDialogProps = {
	clientSecret: string | null;
	description: string;
	onComplete: () => void;
	onFallback: () => Promise<void>;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	title: string;
};

type DialogState = "loading" | "ready" | "redirecting" | "error";

export function StripeEmbeddedCheckoutDialog({
	clientSecret,
	description,
	onComplete,
	onFallback,
	onOpenChange,
	open,
	title,
}: StripeEmbeddedCheckoutDialogProps) {
	const key = env.VITE_STRIPE_PUBLISHABLE_KEY;
	const [stripe, setStripe] = useState<Stripe | null>(null);
	const [state, setState] = useState<DialogState>("loading");
	const [message, setMessage] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	const onCompleteRef = useRef(onComplete);
	const onFallbackRef = useRef(onFallback);
	const fallbackStartedRef = useRef(false);
	const [stableOnComplete] = useState(() => () => onCompleteRef.current());

	useEffect(() => {
		onCompleteRef.current = onComplete;
	}, [onComplete]);

	useEffect(() => {
		onFallbackRef.current = onFallback;
	}, [onFallback]);

	async function startHostedFallback(nextMessage: string) {
		if (fallbackStartedRef.current) return;
		fallbackStartedRef.current = true;
		setState("redirecting");
		setMessage(nextMessage);
		try {
			await onFallbackRef.current();
		} catch {
			fallbackStartedRef.current = false;
			setState("error");
			setMessage("We couldn’t open Stripe checkout. Please try again.");
		}
	}

	useEffect(() => {
		if (!open || !clientSecret) return;
		let cancelled = false;
		fallbackStartedRef.current = false;
		setStripe(null);
		setMessage(null);
		setState("loading");
		void (async () => {
			if (!key) {
				if (!cancelled) {
					await startHostedFallback(
						"Secure checkout isn’t configured in this environment. Opening Stripe instead.",
					);
				}
				return;
			}
			try {
				const nextStripe = await preflightEmbeddedCheckout(key, clientSecret);
				if (cancelled) return;
				setStripe(nextStripe);
				setState("ready");
			} catch {
				resetStripeCache();
				if (!cancelled) {
					await startHostedFallback(
						"We couldn’t load the embedded checkout. Opening Stripe instead.",
					);
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [attempt, clientSecret, key, open]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-4xl"
				data-hosted="true"
				showCloseButton={state !== "redirecting"}
			>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				{state === "ready" && stripe && clientSecret ? (
					<div className="overflow-hidden rounded-lg border">
						<EmbeddedCheckoutProvider
							key={clientSecret}
							stripe={stripe}
							options={{ clientSecret, onComplete: stableOnComplete }}
						>
							<EmbeddedCheckout className="min-h-[32rem]" />
						</EmbeddedCheckoutProvider>
					</div>
				) : state === "error" ? (
					<Alert data-hosted="true" variant="destructive">
						<AlertCircle />
						<AlertDescription className="flex flex-col items-start gap-3">
							<span>{message ?? "We couldn’t load the secure checkout."}</span>
							<div className="flex flex-wrap gap-2">
								<Button
									size="sm"
									variant="outline"
									onClick={() => {
										resetStripeCache();
										setAttempt((value) => value + 1);
									}}
								>
									<RefreshCw /> Retry embedded checkout
								</Button>
								<Button
									size="sm"
									onClick={() => {
										void startHostedFallback("Opening Stripe checkout…");
									}}
								>
									Continue in Stripe
								</Button>
							</div>
						</AlertDescription>
					</Alert>
				) : (
					<div
						data-hosted="true"
						className="flex min-h-40 items-center gap-2 py-6 text-sm text-muted-foreground"
					>
						<Spinner />
						<span>{message ?? "Loading secure checkout…"}</span>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
