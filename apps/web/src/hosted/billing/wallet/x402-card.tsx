"use client";

import {
	createCredentiallessX402Fetch,
	loadX402TopupOffer,
	payX402Topup,
	validateX402TopupAuthority,
	X402PaymentError,
	type X402TopupOffer,
} from "@clawdi/shared/x402";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Link2, RefreshCw, Unlink, WalletCards } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { type Address, getAddress, isAddress } from "viem";
import { SettingsSection } from "@/components/settings-section";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import {
	BILLING_API_ORIGIN,
	isDeployApiConfigured,
	useBillingClient,
} from "@/hosted/billing/billing-client";
import type { WalletBinding, X402TopupAttempt } from "@/hosted/billing/contracts";
import { billingQueryRetry, normalizeBillingError } from "@/hosted/billing/errors";
import { formatUsdExact } from "@/hosted/billing/format";
import { billingKeys } from "@/hosted/billing/query-keys";
import { useActionLock } from "@/hosted/billing/use-action-lock";
import {
	type BrowserWalletConnection,
	BrowserWalletError,
	connectBrowserWallet,
} from "@/hosted/billing/wallet/browser-wallet";
import { invalidateWalletData } from "@/hosted/billing/wallet/top-up-dialog.logic";
import {
	type WalletCacheSnapshot,
	walletSnapshotForCache,
} from "@/hosted/billing/wallet/wallet-cache";

const PAYMENT_REFRESH_INTERVAL_MS = 5_000;
const CHALLENGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOPUP_ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type PendingAction = "binding" | "unbinding" | "offer" | "payment" | "refresh" | null;

function canonicalBindingAddress(binding: WalletBinding): Address | null {
	if (!binding.bound) {
		if (binding.address) throw new Error("Clawdi couldn't connect this wallet. Try again.");
		return null;
	}
	if (!binding.address || !isAddress(binding.address)) {
		throw new Error("Clawdi couldn't connect this wallet. Try again.");
	}
	return getAddress(binding.address);
}

function validateChallenge(challenge: {
	challenge_id: string;
	message: string;
	expires_at: string;
}): void {
	const expiresAt = Date.parse(challenge.expires_at);
	if (
		!CHALLENGE_ID.test(challenge.challenge_id) ||
		!challenge.message ||
		challenge.message.length > 16_384 ||
		!Number.isFinite(expiresAt)
	) {
		throw new Error("Clawdi couldn't verify this wallet connection. Try again.");
	}
}

function validateTopupAttempt(attempt: X402TopupAttempt): X402TopupAttempt {
	const expiresAt = Date.parse(attempt.expires_at);
	if (!TOPUP_ATTEMPT_ID.test(attempt.attempt_id) || !Number.isFinite(expiresAt)) {
		throw new Error("Clawdi couldn't start this payment. Try again.");
	}
	return attempt;
}

function attemptIsTerminal(attempt: WalletCacheSnapshot["x402_payment_attempt"]): boolean {
	return Boolean(attempt && ["completed", "failed", "expired"].includes(attempt.status));
}

function attemptResolvesUnknownOutcome(
	attempt: WalletCacheSnapshot["x402_payment_attempt"],
	attemptId: string,
): boolean {
	return Boolean(attempt && attempt.attempt_id === attemptId && attemptIsTerminal(attempt));
}

function paymentErrorMessage(error: unknown): string {
	if (error instanceof X402PaymentError || error instanceof BrowserWalletError) {
		return error.message;
	}
	return normalizeBillingError(error);
}

function ComingSoonX402Card() {
	return (
		<SettingsSection
			headingLevel={3}
			data-hosted="true"
			title={
				<span className="flex flex-wrap items-center gap-2">
					<span className="inline-flex items-center gap-2">
						<Link2 className="size-4" aria-hidden /> USDC via x402
					</span>
					<Badge variant="secondary">Coming soon</Badge>
				</span>
			}
			description="Browser-wallet USDC funding is not available for this account yet."
		/>
	);
}

export function X402Card({ wallet }: { wallet: WalletCacheSnapshot }) {
	const client = useBillingClient();
	const queryClient = useQueryClient();
	const runAction = useActionLock();
	const [connection, setConnection] = useState<BrowserWalletConnection | null>(null);
	const [pendingAction, setPendingAction] = useState<PendingAction>(null);
	const [offer, setOffer] = useState<X402TopupOffer | null>(null);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [unknownAttemptId, setUnknownAttemptId] = useState<string | null>(null);
	const paymentAttempt = wallet.x402_payment_attempt ?? null;
	const outcomeUnknown = Boolean(
		unknownAttemptId && !attemptResolvesUnknownOutcome(paymentAttempt, unknownAttemptId),
	);
	const serverBlocksPayment =
		wallet.x402_payment_status !== "idle" && paymentAttempt?.status !== "awaiting_payment";
	const hasOutstandingPayment = serverBlocksPayment || outcomeUnknown;
	const shouldPollPayment =
		outcomeUnknown ||
		(wallet.x402_payment_status === "processing" && paymentAttempt?.status !== "awaiting_payment");
	const capabilityReady = Boolean(wallet.x402_enabled && wallet.x402_payment_authority);
	const shouldLoadBinding = capabilityReady || hasOutstandingPayment;

	const binding = useQuery({
		queryKey: billingKeys.walletBinding,
		queryFn: async () => {
			const next = await client.getWalletBinding();
			canonicalBindingAddress(next);
			return next;
		},
		enabled: isDeployApiConfigured() && shouldLoadBinding,
		retry: billingQueryRetry,
		staleTime: 30_000,
	});

	useEffect(() => {
		if (!shouldPollPayment) return;
		const refresh = async () => {
			const [walletResult] = await Promise.allSettled([
				client.getWallet(),
				queryClient.refetchQueries({ queryKey: billingKeys.transactions, type: "active" }),
			]);
			if (walletResult.status !== "fulfilled") return;
			const fresh = walletSnapshotForCache(walletResult.value);
			queryClient.setQueryData(billingKeys.wallet, fresh);
			if (
				unknownAttemptId &&
				attemptResolvesUnknownOutcome(fresh.x402_payment_attempt, unknownAttemptId)
			) {
				setUnknownAttemptId(null);
			}
		};
		const interval = globalThis.setInterval(() => void refresh(), PAYMENT_REFRESH_INTERVAL_MS);
		return () => globalThis.clearInterval(interval);
	}, [client, queryClient, shouldPollPayment, unknownAttemptId]);

	useEffect(() => {
		if (unknownAttemptId && attemptResolvesUnknownOutcome(paymentAttempt, unknownAttemptId)) {
			setUnknownAttemptId(null);
		}
	}, [paymentAttempt, unknownAttemptId]);

	if (!capabilityReady && !hasOutstandingPayment) return <ComingSoonX402Card />;

	let authority: ReturnType<typeof validateX402TopupAuthority> | null = null;
	let authorityInvalid = false;
	if (capabilityReady && wallet.x402_payment_authority) {
		try {
			authority = validateX402TopupAuthority(
				{
					amountAtomic: wallet.x402_payment_authority.amount_atomic,
					origin: wallet.x402_payment_authority.api_origin,
					payTo: wallet.x402_payment_authority.pay_to,
				},
				BILLING_API_ORIGIN,
			);
		} catch {
			authorityInvalid = true;
		}
	}

	const boundAddress = binding.data ? canonicalBindingAddress(binding.data) : null;
	const connectedAddress = connection?.address ?? null;
	const connectionMatches = Boolean(
		boundAddress && connectedAddress && boundAddress === connectedAddress,
	);
	const paymentBlocked =
		pendingAction !== null ||
		binding.isPending ||
		binding.isError ||
		!boundAddress ||
		!authority ||
		authorityInvalid ||
		serverBlocksPayment ||
		outcomeUnknown;
	const amountLabel = authority ? formatUsdExact(authority.amountUsd) : null;

	async function bindBrowserWallet() {
		setPendingAction("binding");
		try {
			const signer = await connectBrowserWallet();
			const challenge = await client.createWalletBindingChallenge({ address: signer.address });
			validateChallenge(challenge);
			const signature = await signer.signMessage(challenge.message);
			const verified = await client.verifyWalletBinding({
				challenge_id: challenge.challenge_id,
				signature,
			});
			if (canonicalBindingAddress(verified) !== signer.address) {
				throw new Error("The selected wallet changed. Select it again and retry.");
			}
			queryClient.setQueryData(billingKeys.walletBinding, verified);
			setConnection(signer);
			toast.success("Browser wallet verified", {
				description: "This address can now fund your Clawdi Wallet.",
			});
		} catch (error) {
			toast.error("Couldn’t verify wallet", { description: paymentErrorMessage(error) });
		} finally {
			setPendingAction(null);
		}
	}

	async function unbindBrowserWallet() {
		setPendingAction("unbinding");
		try {
			await client.deleteWalletBinding();
			queryClient.setQueryData<WalletBinding>(billingKeys.walletBinding, {
				bound: false,
				address: null,
				verified_at: null,
			});
			setConnection(null);
			setConfirmOpen(false);
			toast.success("Browser wallet unbound");
		} catch (error) {
			toast.error("Couldn’t unbind wallet", { description: normalizeBillingError(error) });
		} finally {
			setPendingAction(null);
		}
	}

	async function reviewTopup() {
		if (paymentBlocked || !boundAddress || !authority) return;
		setPendingAction("offer");
		try {
			const signer = await connectBrowserWallet();
			if (signer.address !== boundAddress) {
				setConnection(signer);
				toast.error("Selected wallet doesn’t match", {
					description: "Connect the verified address or change the Wallet binding.",
				});
				return;
			}
			const attempt = validateTopupAttempt(await client.createX402TopupAttempt());
			const paymentFetch = createCredentiallessX402Fetch();
			const nextOffer = await loadX402TopupOffer({
				authenticatedOrigin: BILLING_API_ORIGIN,
				attemptId: attempt.attempt_id,
				authority: authority.authority,
				maxAmountAtomic: authority.amountAtomic,
				fetch: paymentFetch,
			});
			setConnection(signer);
			setOffer(nextOffer);
			setConfirmOpen(true);
		} catch (error) {
			toast.error("Couldn’t load USDC top-up", { description: paymentErrorMessage(error) });
		} finally {
			setPendingAction(null);
		}
	}

	async function refreshAfterUnknownOutcome(): Promise<boolean> {
		const [walletResult] = await Promise.allSettled([
			client.getWallet(),
			queryClient.refetchQueries({ queryKey: billingKeys.transactions, type: "active" }),
		]);
		if (walletResult.status !== "fulfilled") return false;
		const fresh = walletSnapshotForCache(walletResult.value);
		queryClient.setQueryData(billingKeys.wallet, fresh);
		if (
			unknownAttemptId &&
			attemptResolvesUnknownOutcome(fresh.x402_payment_attempt, unknownAttemptId)
		) {
			setUnknownAttemptId(null);
		}
		return true;
	}

	async function refreshUnknownOutcome() {
		setPendingAction("refresh");
		try {
			if (!(await refreshAfterUnknownOutcome())) {
				toast.error("Couldn’t refresh Wallet status", {
					description: "Check your connection and try again. Do not create a new payment yet.",
				});
			}
		} finally {
			setPendingAction(null);
		}
	}

	async function confirmTopup() {
		if (!offer || !connection || !boundAddress || connection.address !== boundAddress) return;
		setPendingAction("payment");
		try {
			const paid = await payX402Topup({
				offer,
				signer: connection,
				fetch: createCredentiallessX402Fetch(),
			});
			setConfirmOpen(false);
			invalidateWalletData(queryClient);
			toast.success("USDC payment verified", {
				description: `Wallet is refreshing from transaction ${paid.settlement.transaction.slice(0, 10)}…`,
			});
		} catch (error) {
			setConfirmOpen(false);
			invalidateWalletData(queryClient);
			if (error instanceof X402PaymentError && error.code === "payment_outcome_unknown") {
				setUnknownAttemptId(offer.attemptId);
				toast.warning("Payment needs a quick check", {
					description: "Refresh the Wallet before trying another payment.",
				});
				await refreshAfterUnknownOutcome();
			} else {
				toast.error("USDC top-up didn’t complete", { description: paymentErrorMessage(error) });
			}
		} finally {
			setPendingAction(null);
		}
	}

	const bindingControlsDisabled =
		pendingAction !== null || serverBlocksPayment || outcomeUnknown || binding.isPending;

	return (
		<>
			<Dialog
				open={confirmOpen}
				onOpenChange={(open) => {
					if (pendingAction === "payment") return;
					setConfirmOpen(open);
				}}
				onOpenChangeComplete={(open) => {
					if (!open) setOffer(null);
				}}
			>
				<DialogContent data-hosted="true" showCloseButton={pendingAction !== "payment"}>
					<DialogHeader>
						<DialogTitle>Confirm Base USDC top-up</DialogTitle>
						<DialogDescription>
							Your browser wallet will authorize this exact x402 payment.
						</DialogDescription>
					</DialogHeader>
					{offer && boundAddress ? (
						<dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-[7rem_minmax(0,1fr)]">
							<dt className="text-muted-foreground">Amount</dt>
							<dd className="font-medium tabular-nums">{formatUsdExact(offer.amountUsd)} USDC</dd>
							<dt className="text-muted-foreground">Network</dt>
							<dd className="font-medium">Base</dd>
							<dt className="text-muted-foreground">Payer</dt>
							<dd className="min-w-0 break-all font-mono text-xs">{boundAddress}</dd>
						</dl>
					) : null}
					<DialogFooter>
						<Button
							variant="outline"
							disabled={pendingAction === "payment"}
							onClick={() => setConfirmOpen(false)}
						>
							Cancel
						</Button>
						<Button
							disabled={!offer || pendingAction === "payment"}
							onClick={() => void runAction(confirmTopup)}
						>
							{pendingAction === "payment" ? <Spinner /> : <WalletCards aria-hidden />}
							{pendingAction === "payment"
								? "Authorizing…"
								: `Pay ${offer ? formatUsdExact(offer.amountUsd) : ""} USDC`}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<SettingsSection
				headingLevel={3}
				data-hosted="true"
				title={
					<span className="flex flex-wrap items-center gap-2">
						<span className="inline-flex items-center gap-2">
							<Link2 className="size-4" aria-hidden /> USDC via x402
						</span>
						<Badge variant="outline">Base</Badge>
					</span>
				}
				description="Fund Wallet directly from a verified browser wallet."
			>
				<div className="space-y-4">
					{binding.isPending ? (
						<div className="flex items-center gap-2 text-sm text-muted-foreground">
							<Spinner /> Checking verified wallet…
						</div>
					) : binding.isError ? (
						<Alert variant="destructive">
							<AlertCircle aria-hidden />
							<AlertTitle>Wallet binding unavailable</AlertTitle>
							<AlertDescription>
								<div className="flex flex-wrap items-center justify-between gap-3">
									<span>{normalizeBillingError(binding.error)}</span>
									<Button size="sm" variant="outline" onClick={() => void binding.refetch()}>
										<RefreshCw aria-hidden /> Retry
									</Button>
								</div>
							</AlertDescription>
						</Alert>
					) : (
						<div className="grid min-w-0 gap-3 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
							<div className="text-muted-foreground">Verified wallet</div>
							<div className="min-w-0 break-all font-mono text-xs">
								{boundAddress ?? "Not bound"}
							</div>
							<div className="text-muted-foreground">Selected wallet</div>
							<div className="min-w-0 break-all font-mono text-xs">
								{connectedAddress ?? "No wallet selected"}
							</div>
						</div>
					)}

					{authorityInvalid ? (
						<Alert variant="destructive">
							<AlertCircle aria-hidden />
							<AlertTitle>USDC funding unavailable</AlertTitle>
							<AlertDescription>
								The authenticated payment authority is invalid. Refresh Wallet before trying again.
							</AlertDescription>
						</Alert>
					) : null}

					{wallet.x402_payment_status === "processing" &&
					paymentAttempt?.status !== "awaiting_payment" ? (
						<Alert>
							<Spinner />
							<AlertTitle>USDC payment processing</AlertTitle>
							<AlertDescription>
								Wallet status is refreshing. A new payment cannot be authorized yet.
							</AlertDescription>
						</Alert>
					) : null}

					{wallet.x402_payment_status === "review_required" ? (
						<Alert variant="destructive">
							<AlertCircle aria-hidden />
							<AlertTitle>Wallet payment needs review</AlertTitle>
							<AlertDescription>
								Do not authorize another payment. Contact support to review the Wallet credit.
							</AlertDescription>
						</Alert>
					) : null}

					{outcomeUnknown ? (
						<Alert variant="destructive">
							<AlertCircle aria-hidden />
							<AlertTitle>Payment outcome needs verification</AlertTitle>
							<AlertDescription>
								<div className="flex flex-wrap items-center justify-between gap-3">
									<span>
										Do not create a new payment until this payment attempt reaches a final status.
									</span>
									<Button
										size="sm"
										variant="outline"
										disabled={pendingAction !== null}
										onClick={() => void runAction(refreshUnknownOutcome)}
									>
										{pendingAction === "refresh" ? <Spinner /> : <RefreshCw aria-hidden />}
										Refresh status
									</Button>
								</div>
							</AlertDescription>
						</Alert>
					) : null}

					{connectedAddress && boundAddress && !connectionMatches ? (
						<Alert variant="destructive">
							<AlertCircle aria-hidden />
							<AlertTitle>Selected wallet doesn’t match</AlertTitle>
							<AlertDescription>
								Connect the verified address or change the Wallet binding before paying.
							</AlertDescription>
						</Alert>
					) : null}

					{!binding.isPending && !binding.isError ? (
						<div className="flex flex-wrap items-center gap-2">
							{boundAddress ? (
								<>
									<Button
										variant="outline"
										disabled={bindingControlsDisabled}
										onClick={() => void runAction(bindBrowserWallet)}
									>
										<RefreshCw aria-hidden /> Change
									</Button>
									<Button
										variant="destructive"
										disabled={bindingControlsDisabled}
										onClick={() => void runAction(unbindBrowserWallet)}
									>
										<Unlink aria-hidden /> Unbind
									</Button>
								</>
							) : (
								<Button
									disabled={bindingControlsDisabled}
									onClick={() => void runAction(bindBrowserWallet)}
								>
									{pendingAction === "binding" ? <Spinner /> : <WalletCards aria-hidden />}
									Connect & bind
								</Button>
							)}
							{boundAddress && amountLabel ? (
								<Button disabled={paymentBlocked} onClick={() => void runAction(reviewTopup)}>
									{pendingAction === "offer" ? <Spinner /> : <WalletCards aria-hidden />}
									{connectedAddress ? "Review" : "Connect & review"} {amountLabel} top-up
								</Button>
							) : null}
						</div>
					) : null}
				</div>
			</SettingsSection>
		</>
	);
}
