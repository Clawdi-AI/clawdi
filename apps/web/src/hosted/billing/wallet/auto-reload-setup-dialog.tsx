"use client";

import { AlertCircle, CreditCard, RefreshCw } from "lucide-react";
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
import type {
	WalletAutoReloadSetupRequest,
	WalletAutoReloadSetupResult,
	WalletState,
} from "@/hosted/billing/contracts";
import { normalizeBillingError } from "@/hosted/billing/errors";
import { formatCents, usdInputToCents } from "@/hosted/billing/format";
import {
	type IdempotencyAttempt,
	idempotencyAttemptFor,
	idempotencyFingerprint,
	newIdempotencyKey,
} from "@/hosted/billing/idempotency";
import {
	StripeSetupForm,
	type WalletSetupConfirmed,
} from "@/hosted/billing/wallet/stripe-setup-form";
import {
	walletSetupIdentityIsCanonical,
	walletSetupIntentMatchesClientSecret,
} from "@/lib/wallet-stripe-return";

type StartSetup = (
	idempotencyKey: string,
	request: Readonly<WalletAutoReloadSetupRequest>,
) => Promise<WalletAutoReloadSetupResult>;
type SetupStartSession = {
	fingerprint: string;
	attempt: IdempotencyAttempt;
	request: Readonly<WalletAutoReloadSetupRequest>;
	startSetup: StartSetup;
};

function setupResultMatchesRequest(
	result: WalletAutoReloadSetupResult,
	request: Readonly<WalletAutoReloadSetupRequest>,
	amountPolicy: WalletState["auto_reload_amount_policy"],
): boolean {
	return (
		result.currency === "usd" &&
		result.consent_version === request.consent_version &&
		result.amount_policy === amountPolicy &&
		usdInputToCents(result.auto_reload_threshold_usd) ===
			usdInputToCents(String(request.auto_reload_threshold_usd)) &&
		result.auto_reload_amount_cents === request.auto_reload_amount_cents &&
		result.auto_reload_monthly_cap_cents === request.auto_reload_monthly_cap_cents &&
		walletSetupIdentityIsCanonical(result.setup_identity) &&
		walletSetupIntentMatchesClientSecret(result.client_secret, result.setup_intent_id)
	);
}

export function AutoReloadSetupDialog({
	open,
	onOpenChange,
	request,
	amountPolicy,
	startSetup,
	finalizeSetup,
	onComplete,
	title = "Authorize a card for auto-reload",
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	request: WalletAutoReloadSetupRequest;
	amountPolicy: WalletState["auto_reload_amount_policy"];
	startSetup: StartSetup;
	finalizeSetup: (confirmed: WalletSetupConfirmed) => Promise<void>;
	onComplete: () => void;
	title?: string;
}) {
	const [attempt, setAttempt] = useState<WalletAutoReloadSetupResult | null>(null);
	const [confirmed, setConfirmed] = useState<WalletSetupConfirmed | null>(null);
	const [startAttempt, setStartAttempt] = useState(0);
	const [starting, setStarting] = useState(false);
	const [startRetryable, setStartRetryable] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const startGenerationRef = useRef(0);
	const startSessionRef = useRef<SetupStartSession | null>(null);
	const startPromiseRef = useRef<Promise<WalletAutoReloadSetupResult> | null>(null);
	const newSessionOnOpenRef = useRef(false);
	const startSetupRef = useRef(startSetup);
	startSetupRef.current = startSetup;
	const setupFingerprint = idempotencyFingerprint({ amountPolicy, request });
	const sessionMatchesSettings = startSessionRef.current?.fingerprint === setupFingerprint;
	const visibleAttempt = sessionMatchesSettings ? attempt : null;
	const visibleError = sessionMatchesSettings ? error : null;

	useEffect(() => {
		if (!open) return;
		const generation = startGenerationRef.current + 1;
		startGenerationRef.current = generation;
		setAttempt(null);
		setConfirmed(null);
		setError(null);
		setStartRetryable(false);
		setStarting(true);
		const currentSession = newSessionOnOpenRef.current ? null : startSessionRef.current;
		newSessionOnOpenRef.current = false;
		const session =
			currentSession?.fingerprint === setupFingerprint
				? currentSession
				: {
						fingerprint: setupFingerprint,
						attempt: idempotencyAttemptFor(
							null,
							"wallet-auto-reload-setup",
							setupFingerprint,
							newIdempotencyKey,
							{ storage: null },
						),
						request: { ...request },
						startSetup: startSetupRef.current,
					};
		if (session !== currentSession) {
			startSessionRef.current = session;
			startPromiseRef.current = null;
		}
		startPromiseRef.current ??= session.startSetup(session.attempt.key, session.request);
		void startPromiseRef.current
			.then((nextAttempt) => {
				if (startGenerationRef.current !== generation) return;
				if (!setupResultMatchesRequest(nextAttempt, session.request, amountPolicy)) {
					setError("The card setup response could not be verified. Close and start a new attempt.");
					return;
				}
				if (nextAttempt.status === "canceled" || nextAttempt.status === "succeeded") {
					setError(
						"This card authorization can’t be continued. Close this dialog and start a new attempt.",
					);
					return;
				}
				setAttempt(nextAttempt);
			})
			.catch((nextError: unknown) => {
				if (startGenerationRef.current === generation) {
					setError(normalizeBillingError(nextError));
					setStartRetryable(true);
				}
			})
			.finally(() => {
				if (startGenerationRef.current === generation) setStarting(false);
			});
		return () => {
			startGenerationRef.current += 1;
		};
	}, [amountPolicy, open, setupFingerprint, startAttempt]);

	function resetSession() {
		startGenerationRef.current += 1;
		startSessionRef.current = null;
		startPromiseRef.current = null;
		newSessionOnOpenRef.current = false;
		setAttempt(null);
		setConfirmed(null);
		setStarting(false);
		setStartRetryable(false);
		setSubmitting(false);
		setError(null);
	}

	function changeOpen(nextOpen: boolean) {
		if (!nextOpen && submitting) return;
		if (!nextOpen) {
			startGenerationRef.current += 1;
			newSessionOnOpenRef.current = true;
		}
		onOpenChange(nextOpen);
	}

	async function finalize(nextConfirmed: WalletSetupConfirmed): Promise<void> {
		setError(null);
		setConfirmed(nextConfirmed);
		await finalizeSetup(nextConfirmed);
		startSessionRef.current = null;
		startPromiseRef.current = null;
		setSubmitting(false);
		setConfirmed(null);
		onComplete();
		onOpenChange(false);
	}

	const thresholdCents = usdInputToCents(String(request.auto_reload_threshold_usd));
	const monthlyCap =
		request.auto_reload_monthly_cap_cents === 0
			? "There is no monthly limit on the final amount added and charged."
			: `Auto-reload pauses for the month after the final amount added and charged reaches ${formatCents(request.auto_reload_monthly_cap_cents)}.`;

	return (
		<Dialog
			open={open}
			onOpenChange={changeOpen}
			onOpenChangeComplete={(nextOpen) => {
				if (!nextOpen) resetSession();
			}}
		>
			<DialogContent
				data-hosted="true"
				className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-lg"
			>
				<DialogHeader>
					<div className="flex items-center gap-3">
						<div className="flex size-8 items-center justify-center rounded-md bg-muted text-foreground">
							<CreditCard aria-hidden className="size-4" />
						</div>
						<DialogTitle>{title}</DialogTitle>
					</div>
					<DialogDescription>
						Confirm the automatic Wallet reload terms, then enter a card.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4">
					<div className="border-l-2 border-primary/50 pl-3 text-sm leading-5">
						<p className="font-medium">Authorization summary</p>
						<ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-muted-foreground">
							<li>Clawdi saves this card only for automatic Wallet reloads.</li>
							<li>
								Clawdi charges it off-session when your balance drops below{" "}
								{formatCents(thresholdCents ?? 0)}.
							</li>
							<li>
								Each reload adds {formatCents(request.auto_reload_amount_cents)}, plus any amount
								needed to bring a negative balance back to $0.
							</li>
							<li>{monthlyCap}</li>
							<li>
								Charges are in USD. Your card issuer or network handles any currency conversion and
								may charge a fee.
							</li>
							<li>You can disable auto-reload at any time.</li>
						</ul>
					</div>

					{visibleError ? (
						<Alert variant="destructive">
							<AlertCircle aria-hidden />
							<AlertDescription className="flex flex-col items-start gap-3">
								<span>{visibleError}</span>
								{startRetryable && !starting && !visibleAttempt ? (
									<Button
										type="button"
										size="sm"
										variant="outline"
										onClick={() => {
											startPromiseRef.current = null;
											setStartAttempt((current) => current + 1);
										}}
									>
										<RefreshCw data-icon="inline-start" /> Retry card setup
									</Button>
								) : null}
							</AlertDescription>
						</Alert>
					) : null}

					{starting || !sessionMatchesSettings ? (
						<div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
							<Spinner data-icon="inline-start" /> Preparing secure card setup…
						</div>
					) : visibleAttempt ? (
						<StripeSetupForm
							clientSecret={visibleAttempt.client_secret}
							setupIdentity={visibleAttempt.setup_identity}
							expectedSetupIntentId={visibleAttempt.setup_intent_id}
							confirmed={confirmed}
							onCancel={() => changeOpen(false)}
							onConfirmed={finalize}
							onSubmittingChange={setSubmitting}
						/>
					) : null}
				</div>
			</DialogContent>
		</Dialog>
	);
}
