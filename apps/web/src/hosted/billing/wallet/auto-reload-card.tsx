"use client";

import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CreditCard, Repeat } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useSettingsEditState } from "@/components/settings-edit-state";
import { SettingsSection } from "@/components/settings-section";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import type { WalletState } from "@/hosted/billing/contracts";
import { formatCents } from "@/hosted/billing/format";
import { billingKeys } from "@/hosted/billing/query-keys";
import { useSensitiveSetAutoReload } from "@/hosted/billing/sensitive-actions";
import {
	type PaymentIntentClientSecret,
	walletAutoReloadPaymentIntentClientSecret,
} from "@/hosted/billing/stripe-client-secret";
import { useActionLock } from "@/hosted/billing/use-action-lock";
import { AutoReloadActionConfirm } from "@/hosted/billing/wallet/auto-reload-action";
import {
	type AutoReloadDraft,
	type AutoReloadSaveError,
	autoReloadDraftFromWallet,
	autoReloadDraftIsDirty,
	autoReloadFormState,
	autoReloadRequest,
	autoReloadSaveError,
	autoReloadStatusSummary,
} from "@/hosted/billing/wallet/auto-reload-card.logic";
import type { WalletCacheSnapshot } from "@/hosted/billing/wallet/wallet-cache";
import {
	AUTORELOAD_AMOUNT_MAX_CENTS,
	AUTORELOAD_AMOUNT_MIN_CENTS,
	AUTORELOAD_AMOUNT_RANGE_LABEL,
	AUTORELOAD_THRESHOLD_MIN_USD,
} from "@/hosted/billing/wallet/wallet-constants";

type AutoReloadField = "threshold" | "amount" | "cap";
type BlurredFields = Record<AutoReloadField, boolean>;

const PRISTINE_FIELDS: BlurredFields = { threshold: false, amount: false, cap: false };
const ALL_FIELDS_BLURRED: BlurredFields = { threshold: true, amount: true, cap: true };

export function AutoReloadCard({
	wallet,
	onTopUp,
}: {
	wallet: WalletCacheSnapshot;
	onTopUp?: () => void;
}) {
	const save = useSensitiveSetAutoReload();
	const queryClient = useQueryClient();
	const runAction = useActionLock();
	const initialDraft = autoReloadDraftFromWallet(wallet);
	const [baseline, setBaseline] = useState<AutoReloadDraft>(initialDraft);
	const [draft, setDraft] = useState<AutoReloadDraft>(initialDraft);
	const [blurred, setBlurred] = useState<BlurredFields>(PRISTINE_FIELDS);
	const [requestError, setRequestError] = useState<AutoReloadSaveError | null>(null);
	const [actionClientSecret, setActionClientSecret] = useState<PaymentIntentClientSecret | null>(
		null,
	);
	const draftRef = useRef(draft);
	const baselineRef = useRef(baseline);
	const pendingRef = useRef(save.isPending);
	draftRef.current = draft;
	baselineRef.current = baseline;
	pendingRef.current = save.isPending;

	const form = autoReloadFormState(draft);
	const dirty = autoReloadDraftIsDirty(draft, baseline);
	const status = autoReloadStatusSummary(wallet);
	useSettingsEditState({ dirty, busy: save.isPending });

	useEffect(() => {
		const next = autoReloadDraftFromWallet(wallet);
		const wasDirty = autoReloadDraftIsDirty(draftRef.current, baselineRef.current);
		setBaseline(next);
		if (!wasDirty && !pendingRef.current) {
			setDraft(next);
			setBlurred(PRISTINE_FIELDS);
			setRequestError(null);
		}
	}, [
		wallet.auto_reload_enabled,
		wallet.auto_reload_threshold_usd,
		wallet.auto_reload_amount_cents,
		wallet.auto_reload_monthly_cap_cents,
	]);

	useEffect(() => {
		if (!wallet.auto_reload_action) setActionClientSecret(null);
	}, [wallet.auto_reload_action?.attempt_id, wallet.auto_reload_action]);

	function updateDraft<K extends keyof AutoReloadDraft>(key: K, value: AutoReloadDraft[K]) {
		setDraft((current) => ({ ...current, [key]: value }));
		setRequestError(null);
	}

	function markBlurred(field: AutoReloadField) {
		setBlurred((current) => ({ ...current, [field]: true }));
	}

	function cancelChanges() {
		if (save.isPending) return;
		setDraft(baseline);
		setBlurred(PRISTINE_FIELDS);
		setRequestError(null);
	}

	function acceptSavedWallet(nextWallet: WalletState) {
		setActionClientSecret(walletAutoReloadPaymentIntentClientSecret(nextWallet.auto_reload_action));
		queryClient.invalidateQueries({ queryKey: billingKeys.wallet });
		const next = autoReloadDraftFromWallet(nextWallet);
		setBaseline(next);
		setDraft(next);
		setBlurred(PRISTINE_FIELDS);
		setRequestError(null);
	}

	function handleSaveFailure(error: unknown) {
		const copy = autoReloadSaveError(error);
		setRequestError(copy);
		const field = copy.field;
		if (field) {
			setBlurred((current) => ({ ...current, [field]: true }));
			window.requestAnimationFrame(() => document.getElementById(`ar-${field}`)?.focus());
		}
		toast.error(copy.title, { description: copy.description });
	}

	async function saveChanges() {
		const request = autoReloadRequest(draft);
		if (!dirty || !request || save.isPending) return;
		setRequestError(null);
		try {
			const nextWallet = await save.execute(request);
			acceptSavedWallet(nextWallet);
			toast.success("Auto-reload settings saved");
		} catch (error) {
			handleSaveFailure(error);
		}
	}

	const thresholdInvalid = blurred.threshold && !form.thresholdValid;
	const amountInvalid = blurred.amount && !form.amountValid;
	const capInvalid = blurred.cap && !form.capValid;
	const thresholdServerError = requestError?.field === "threshold";
	const amountServerError = requestError?.field === "amount";
	const capServerError = requestError?.field === "cap";
	const minimumCap = form.amountValid ? formatCents(form.amountCents) : "the reload amount";
	const cap = wallet.auto_reload_monthly_cap_cents;
	const usage =
		cap === 0
			? `${formatCents(wallet.auto_reload_monthly_spent_cents)} added this month · No monthly limit`
			: `${formatCents(wallet.auto_reload_monthly_spent_cents)} of ${formatCents(cap)} used · Resets ${new Intl.DateTimeFormat(
					"en-US",
					{ month: "short", day: "numeric", timeZone: "UTC" },
				).format(new Date(wallet.auto_reload_period_end))}`;

	return (
		<SettingsSection
			headingLevel={3}
			data-hosted="true"
			title={
				<span className="flex flex-wrap items-center gap-2">
					<span className="inline-flex items-center gap-2">
						<Repeat className="size-4" aria-hidden /> Auto-reload
					</span>
					<StatusBadge status={status.tone} withDot>
						{status.label}
					</StatusBadge>
				</span>
			}
			description={status.description}
		>
			<div className="flex max-w-3xl flex-col gap-4">
				<AutoReloadActionConfirm
					wallet={wallet}
					onTopUp={onTopUp}
					initialClientSecret={actionClientSecret}
					onDiscardClientSecret={() => setActionClientSecret(null)}
				/>

				{requestError ? (
					<Alert variant="destructive">
						<AlertCircle aria-hidden />
						<AlertTitle>{requestError.title}</AlertTitle>
						<AlertDescription id="auto-reload-save-error" className="flex flex-col gap-3">
							<span>{requestError.description}</span>
							{requestError.requiresPaymentMethod && onTopUp ? (
								<Button type="button" size="sm" variant="outline" onClick={onTopUp}>
									<CreditCard data-icon="inline-start" /> Add a card
								</Button>
							) : null}
						</AlertDescription>
					</Alert>
				) : null}

				<form
					id="auto-reload-form"
					className="overflow-hidden rounded-lg border bg-muted/10"
					onSubmit={(event) => {
						event.preventDefault();
						setBlurred(ALL_FIELDS_BLURRED);
						void runAction(saveChanges);
					}}
				>
					<div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-4 p-4 sm:p-5">
						<div className="space-y-1">
							<Label htmlFor="ar-enabled">Automatically add funds</Label>
							<p className="text-xs leading-5 text-muted-foreground">
								{wallet.auto_reload_enabled
									? usage
									: "Turn this on to reload Wallet when the balance reaches your threshold."}
							</p>
						</div>
						<div className="flex items-center gap-2">
							<span className="text-xs font-medium text-muted-foreground">
								{draft.enabled ? "On" : "Off"}
							</span>
							<Switch
								id="ar-enabled"
								data-auto-reload-primary
								checked={draft.enabled}
								onCheckedChange={(checked) => updateDraft("enabled", checked)}
								disabled={save.isPending}
							/>
						</div>
					</div>

					<div className="grid gap-5 border-t p-4 sm:grid-cols-2 sm:p-5">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="ar-threshold">When balance is below (USD)</Label>
							<Input
								id="ar-threshold"
								type="number"
								inputMode="decimal"
								autoComplete="off"
								min={AUTORELOAD_THRESHOLD_MIN_USD}
								step="0.01"
								className="tabular-nums [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
								value={draft.threshold}
								onChange={(event) => updateDraft("threshold", event.target.value)}
								onBlur={() => markBlurred("threshold")}
								disabled={!draft.enabled || save.isPending}
								aria-invalid={thresholdInvalid || thresholdServerError}
								aria-describedby="ar-threshold-help"
							/>
							<p
								id="ar-threshold-help"
								className={
									thresholdInvalid ? "text-xs text-destructive" : "text-xs text-muted-foreground"
								}
							>
								Minimum {formatCents(AUTORELOAD_THRESHOLD_MIN_USD * 100)}.
							</p>
						</div>

						<div className="flex flex-col gap-1.5">
							<Label htmlFor="ar-amount">Amount to add (USD)</Label>
							<Input
								id="ar-amount"
								type="number"
								inputMode="decimal"
								autoComplete="off"
								min={AUTORELOAD_AMOUNT_MIN_CENTS / 100}
								max={AUTORELOAD_AMOUNT_MAX_CENTS / 100}
								step="0.01"
								className="tabular-nums [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
								value={draft.amount}
								onChange={(event) => updateDraft("amount", event.target.value)}
								onBlur={() => markBlurred("amount")}
								disabled={!draft.enabled || save.isPending}
								aria-invalid={amountInvalid || amountServerError}
								aria-describedby="ar-amount-help"
							/>
							<p
								id="ar-amount-help"
								className={
									amountInvalid ? "text-xs text-destructive" : "text-xs text-muted-foreground"
								}
							>
								{AUTORELOAD_AMOUNT_RANGE_LABEL}.
							</p>
						</div>
					</div>

					<div className="border-t p-4 sm:p-5">
						<div className="flex items-start justify-between gap-3">
							<div className="space-y-0.5">
								<Label htmlFor="ar-monthly-limit">Monthly limit</Label>
								<p className="text-xs text-muted-foreground">
									{draft.monthlyLimitEnabled
										? "Pause auto-reload after this amount is added."
										: "No monthly limit."}
								</p>
							</div>
							<Switch
								id="ar-monthly-limit"
								checked={draft.monthlyLimitEnabled}
								onCheckedChange={(checked) => updateDraft("monthlyLimitEnabled", checked)}
								disabled={!draft.enabled || save.isPending}
							/>
						</div>

						{draft.monthlyLimitEnabled ? (
							<div className="mt-4 flex flex-col gap-1.5">
								<Label htmlFor="ar-cap">Monthly limit (USD)</Label>
								<Input
									id="ar-cap"
									type="number"
									inputMode="decimal"
									autoComplete="off"
									min={AUTORELOAD_AMOUNT_MIN_CENTS / 100}
									step="0.01"
									className="tabular-nums [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
									value={draft.cap}
									onChange={(event) => updateDraft("cap", event.target.value)}
									onBlur={() => markBlurred("cap")}
									disabled={!draft.enabled || save.isPending}
									aria-invalid={capInvalid || capServerError}
									aria-describedby="ar-cap-help"
								/>
								<p
									id="ar-cap-help"
									className={
										capInvalid ? "text-xs text-destructive" : "text-xs text-muted-foreground"
									}
								>
									Must cover at least one reload ({minimumCap}).
								</p>
							</div>
						) : null}
					</div>

					<div className="flex flex-col gap-3 border-t p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
						<p className="text-xs leading-5 text-muted-foreground">
							Uses your saved card. A manual top-up saves a card for future reloads.
						</p>
						<div className="flex shrink-0 justify-end gap-2">
							<Button
								type="button"
								size="sm"
								variant="outline"
								onClick={cancelChanges}
								disabled={!dirty || save.isPending}
							>
								Cancel
							</Button>
							<Button
								type="submit"
								size="sm"
								disabled={!dirty || !form.formValid || save.isPending}
							>
								{save.isPending ? (
									<>
										<Spinner data-icon="inline-start" /> Saving…
									</>
								) : (
									"Save"
								)}
							</Button>
						</div>
					</div>
				</form>
			</div>
		</SettingsSection>
	);
}
