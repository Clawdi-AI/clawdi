"use client";

import {
	CheckoutElementsProvider,
	PaymentElement,
	useCheckoutElements,
} from "@stripe/react-stripe-js/checkout";
import type { Stripe, StripeCheckoutElementsSdkOptions } from "@stripe/stripe-js";
import { AlertCircle, CreditCard, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { getStripe, resetStripeCache } from "@/hosted/billing/stripe";
import { env } from "@/lib/env";

export type StripeCheckoutSummary = {
	detail: string;
	planName: string;
	priceLabel: string;
	termLabel: string;
};

type StripeCheckoutDialogProps = {
	clientSecret: string | null;
	description: string;
	onComplete: () => void;
	onFallback: () => Promise<void>;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	summary: StripeCheckoutSummary | null;
	title: string;
};

type DialogState = "loading" | "ready" | "redirecting" | "error";
type CheckoutAppearance = NonNullable<
	NonNullable<StripeCheckoutElementsSdkOptions["elementsOptions"]>["appearance"]
>;

const FALLBACK_THEME = {
	background: "oklch(0.175 0.004 95)",
	border: "oklch(0.275 0.005 95)",
	destructive: "oklch(0.62 0.19 27)",
	foreground: "oklch(0.92 0.004 95)",
	input: "oklch(0.33 0.006 95)",
	muted: "oklch(0.245 0.005 95)",
	mutedForeground: "oklch(0.63 0.006 95)",
	primary: "oklch(0.6724 0.1308 38.7559)",
	radius: "0.625rem",
};

function checkoutAppearanceFromTheme(): CheckoutAppearance {
	const style =
		typeof window === "undefined" ? null : window.getComputedStyle(document.documentElement);
	const token = (name: string, fallback: string) =>
		style?.getPropertyValue(name).trim() || fallback;
	const isDark =
		typeof document !== "undefined" && document.documentElement.classList.contains("dark");

	return {
		theme: isDark ? "night" : "stripe",
		variables: {
			borderRadius: token("--radius", FALLBACK_THEME.radius),
			colorBackground: token("--background", FALLBACK_THEME.background),
			colorDanger: token("--destructive", FALLBACK_THEME.destructive),
			colorIconTab: token("--muted-foreground", FALLBACK_THEME.mutedForeground),
			colorIconTabSelected: token("--primary", FALLBACK_THEME.primary),
			colorPrimary: token("--primary", FALLBACK_THEME.primary),
			colorText: token("--foreground", FALLBACK_THEME.foreground),
			colorTextPlaceholder: token("--muted-foreground", FALLBACK_THEME.mutedForeground),
			colorTextSecondary: token("--muted-foreground", FALLBACK_THEME.mutedForeground),
			fontFamily: token("--font-sans", '"Geist Sans", sans-serif'),
			spacingUnit: "4px",
		},
		rules: {
			".Block": {
				backgroundColor: token("--muted", FALLBACK_THEME.muted),
				borderColor: token("--border", FALLBACK_THEME.border),
			},
			".Input": {
				backgroundColor: token("--background", FALLBACK_THEME.background),
				borderColor: token("--input", FALLBACK_THEME.input),
				boxShadow: "none",
			},
			".Input:focus": {
				borderColor: token("--primary", FALLBACK_THEME.primary),
				boxShadow: "none",
			},
			".Tab": {
				backgroundColor: token("--muted", FALLBACK_THEME.muted),
				borderColor: token("--border", FALLBACK_THEME.border),
				boxShadow: "none",
			},
			".Tab--selected": {
				borderColor: token("--primary", FALLBACK_THEME.primary),
				boxShadow: "none",
			},
		},
	};
}

function useCheckoutAppearance(open: boolean): CheckoutAppearance {
	const [appearance, setAppearance] = useState<CheckoutAppearance>(() =>
		checkoutAppearanceFromTheme(),
	);

	useEffect(() => {
		if (!open || typeof MutationObserver === "undefined") return;
		const update = () => setAppearance(checkoutAppearanceFromTheme());
		update();
		const observer = new MutationObserver(update);
		observer.observe(document.documentElement, {
			attributeFilter: ["class", "style"],
			attributes: true,
		});
		return () => observer.disconnect();
	}, [open]);

	return appearance;
}

function CheckoutSummaryPanel({ summary }: { summary: StripeCheckoutSummary | null }) {
	if (!summary) return null;

	return (
		<div className="rounded-lg border bg-muted/30 p-4">
			<div className="flex items-start gap-3">
				<div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-background text-primary">
					<CreditCard className="size-4" />
				</div>
				<div className="min-w-0 flex-1">
					<p className="text-xs text-muted-foreground">Order summary</p>
					<div className="mt-1 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
						<div className="min-w-0">
							<p className="truncate font-medium">{summary.planName}</p>
							<p className="text-xs text-muted-foreground">{summary.detail}</p>
						</div>
						<div className="text-left sm:text-right">
							<p className="font-mono text-base tabular-nums">{summary.priceLabel}</p>
							<p className="text-xs text-muted-foreground">{summary.termLabel}</p>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

function CheckoutElementForm({
	onComplete,
	onLoadError,
	onSubmittingChange,
}: {
	onComplete: () => void;
	onLoadError: (message: string) => void;
	onSubmittingChange: (submitting: boolean) => void;
}) {
	const checkoutState = useCheckoutElements();
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const submittingRef = useRef(false);
	const loadErrorMessage = checkoutState.type === "error" ? checkoutState.error.message : null;

	function finishSubmitting() {
		submittingRef.current = false;
		setSubmitting(false);
		onSubmittingChange(false);
	}

	useEffect(() => {
		if (loadErrorMessage) onLoadError(loadErrorMessage);
	}, [loadErrorMessage, onLoadError]);

	if (checkoutState.type === "loading") {
		return (
			<div
				data-hosted="true"
				className="flex min-h-36 items-center gap-2 py-6 text-sm text-muted-foreground"
			>
				<Spinner />
				<span>Loading secure payment form…</span>
			</div>
		);
	}

	if (checkoutState.type === "error") {
		return (
			<Alert data-hosted="true" variant="destructive">
				<AlertCircle />
				<AlertDescription>
					We could not initialize the secure payment form. Opening Stripe instead.
				</AlertDescription>
			</Alert>
		);
	}

	const { checkout } = checkoutState;

	async function confirmCheckout() {
		if (submittingRef.current || !checkout.canConfirm) return;
		submittingRef.current = true;
		setSubmitting(true);
		onSubmittingChange(true);
		setError(null);
		try {
			const result = await checkout.confirm({ redirect: "if_required" });
			if (result.type === "error") {
				setError(result.error.message || "We could not confirm this payment. Please try again.");
				finishSubmitting();
				return;
			}
			if (result.session.status.type === "complete") {
				onComplete();
				return;
			}
			setError("Stripe needs another step before this checkout can finish.");
			finishSubmitting();
		} catch {
			setError("We could not reach Stripe. Check your connection and try again.");
			finishSubmitting();
		}
	}

	return (
		<div data-hosted="true" className="flex flex-col gap-4">
			<PaymentElement
				options={{
					layout: { type: "tabs", defaultCollapsed: false },
					wallets: { applePay: "never", googlePay: "never", link: "never" },
				}}
			/>
			{error ? (
				<Alert data-hosted="true" variant="destructive">
					<AlertCircle />
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}
			<div className="flex justify-end">
				<Button
					type="button"
					onClick={confirmCheckout}
					disabled={submitting || !checkout.canConfirm}
				>
					{submitting ? (
						<>
							<Spinner data-icon="inline-start" /> Processing…
						</>
					) : (
						"Subscribe"
					)}
				</Button>
			</div>
		</div>
	);
}

export function StripeCheckoutDialog({
	clientSecret,
	description,
	onComplete,
	onFallback,
	onOpenChange,
	open,
	summary,
	title,
}: StripeCheckoutDialogProps) {
	const key = env.VITE_STRIPE_PUBLISHABLE_KEY;
	const [stripe, setStripe] = useState<Stripe | null>(null);
	const [state, setState] = useState<DialogState>("loading");
	const [message, setMessage] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	const [checkoutSubmitting, setCheckoutSubmitting] = useState(false);
	const appearance = useCheckoutAppearance(open);
	const onCompleteRef = useRef(onComplete);
	const onFallbackRef = useRef(onFallback);
	const fallbackStartedRef = useRef(false);

	useEffect(() => {
		onCompleteRef.current = onComplete;
	}, [onComplete]);

	useEffect(() => {
		onFallbackRef.current = onFallback;
	}, [onFallback]);

	const completeCheckout = useCallback(() => {
		onCompleteRef.current();
	}, []);

	const startHostedFallback = useCallback(async (nextMessage: string) => {
		if (fallbackStartedRef.current) return;
		fallbackStartedRef.current = true;
		setState("redirecting");
		setMessage(nextMessage);
		try {
			await onFallbackRef.current();
		} catch {
			fallbackStartedRef.current = false;
			setState("error");
			setMessage("We could not open Stripe checkout. Please try again.");
		}
	}, []);

	const handleProviderLoadError = useCallback(
		() => startHostedFallback("We could not load the payment form. Opening Stripe instead."),
		[startHostedFallback],
	);

	useEffect(() => {
		if (!open || !clientSecret) return;
		let cancelled = false;
		fallbackStartedRef.current = false;
		setCheckoutSubmitting(false);
		setStripe(null);
		setMessage(null);
		setState("loading");
		void (async () => {
			if (!key) {
				if (!cancelled) {
					await startHostedFallback(
						"Secure checkout is not configured in this environment. Opening Stripe instead.",
					);
				}
				return;
			}
			try {
				const nextStripe = await getStripe(key);
				if (!nextStripe) {
					throw new Error("Stripe.js failed to initialize.");
				}
				if (cancelled) return;
				setStripe(nextStripe);
				setState("ready");
			} catch {
				resetStripeCache();
				if (!cancelled) {
					await startHostedFallback(
						"We could not load Stripe.js. Opening Stripe checkout instead.",
					);
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [attempt, clientSecret, key, open, startHostedFallback]);

	const providerOptions = useMemo<StripeCheckoutElementsSdkOptions | null>(() => {
		if (!clientSecret) return null;
		return {
			clientSecret,
			elementsOptions: {
				appearance,
				loader: "auto",
				savedPaymentMethod: {
					enableRedisplay: "never",
					enableSave: "never",
				},
			},
		};
	}, [appearance, clientSecret]);

	function requestOpenChange(nextOpen: boolean) {
		if (!nextOpen && (checkoutSubmitting || state === "redirecting")) return;
		onOpenChange(nextOpen);
	}

	return (
		<Dialog open={open} onOpenChange={requestOpenChange}>
			<DialogContent
				className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
				data-hosted="true"
				showCloseButton={state !== "redirecting" && !checkoutSubmitting}
			>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				<CheckoutSummaryPanel summary={summary} />
				<Separator />
				{state === "ready" && stripe && providerOptions ? (
					<CheckoutElementsProvider
						key={`${clientSecret}:${attempt}`}
						stripe={stripe}
						options={providerOptions}
					>
						<CheckoutElementForm
							onComplete={completeCheckout}
							onLoadError={handleProviderLoadError}
							onSubmittingChange={setCheckoutSubmitting}
						/>
					</CheckoutElementsProvider>
				) : state === "error" ? (
					<Alert data-hosted="true" variant="destructive">
						<AlertCircle />
						<AlertDescription className="flex flex-col items-start gap-3">
							<span>{message ?? "We could not load the secure checkout."}</span>
							<div className="flex flex-wrap gap-2">
								<Button
									size="sm"
									variant="outline"
									onClick={() => {
										resetStripeCache();
										setAttempt((value) => value + 1);
									}}
								>
									<RefreshCw data-icon="inline-start" /> Retry payment form
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
						className="flex min-h-36 items-center gap-2 py-6 text-sm text-muted-foreground"
					>
						<Spinner />
						<span>{message ?? "Loading secure checkout…"}</span>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
