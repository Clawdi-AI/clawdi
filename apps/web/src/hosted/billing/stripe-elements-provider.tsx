"use client";

import { Elements } from "@stripe/react-stripe-js";
import type { Stripe } from "@stripe/stripe-js";
import { AlertCircle, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { getStripe, resetStripeCache } from "@/hosted/billing/stripe";
import { useStripeAppearance } from "@/hosted/billing/stripe-appearance";
import { env } from "@/lib/env";

export function StripeElementsProvider({
	clientSecret,
	children,
}: {
	clientSecret: string;
	children: ReactNode;
}) {
	const key = env.VITE_STRIPE_PUBLISHABLE_KEY;
	const [stripe, setStripe] = useState<Stripe | null | undefined>(undefined);
	const [attempt, setAttempt] = useState(0);
	const appearance = useStripeAppearance();

	useEffect(() => {
		if (!key) return;
		let cancelled = false;
		setStripe(undefined);
		getStripe(key)
			.then((nextStripe) => {
				if (!cancelled) setStripe(nextStripe);
			})
			.catch(() => {
				resetStripeCache();
				if (!cancelled) setStripe(null);
			});
		return () => {
			cancelled = true;
		};
	}, [key, attempt]);

	if (!key) {
		return (
			<Alert data-hosted="true">
				<AlertCircle aria-hidden />
				<AlertDescription>
					Secure payments are temporarily unavailable. Please try again later.
				</AlertDescription>
			</Alert>
		);
	}

	if (stripe === null) {
		return (
			<Alert data-hosted="true" variant="destructive">
				<AlertCircle aria-hidden />
				<AlertDescription className="flex flex-col items-start gap-3">
					<span>
						We couldn’t load the secure payment form. Check your connection or ad blocker and try
						again.
					</span>
					<Button
						type="button"
						size="sm"
						variant="outline"
						onClick={() => {
							resetStripeCache();
							setAttempt((current) => current + 1);
						}}
					>
						<RefreshCw data-icon="inline-start" /> Retry payment form
					</Button>
				</AlertDescription>
			</Alert>
		);
	}

	if (stripe === undefined) {
		return (
			<div
				data-hosted="true"
				className="flex items-center gap-2 py-6 text-sm text-muted-foreground"
			>
				<Spinner data-icon="inline-start" /> Loading secure payment…
			</div>
		);
	}

	return (
		<div data-hosted="true">
			<Elements key={clientSecret} stripe={stripe} options={{ clientSecret, appearance }}>
				{children}
			</Elements>
		</div>
	);
}
