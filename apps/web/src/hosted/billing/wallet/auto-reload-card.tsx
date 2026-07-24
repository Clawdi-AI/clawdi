"use client";

import { AlertCircle, CreditCard, Repeat } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useSettingsEditState } from "@/components/settings-edit-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import type { WalletState } from "@/hosted/billing/contracts";
import { formatCents } from "@/hosted/billing/format";
import { useSetAutoReload } from "@/hosted/billing/hooks";
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
} from "@/hosted/billing/wallet/auto-reload-card.logic";
import {
	AUTORELOAD_AMOUNT_MAX_CENTS,
	AUTORELOAD_AMOUNT_MIN_CENTS,
	AUTORELOAD_THRESHOLD_MIN_USD,
} from "@/hosted/billing/wallet/wallet-constants";

type AutoReloadField = "threshold" | "amount" | "cap";
type BlurredFields = Record<AutoReloadField, boolean>;

const PRISTINE_FIELDS: BlurredFields = { threshold: false, amount: false, cap: false };
const ALL_FIELDS_BLURRED: BlurredFields = { threshold: true, amount: true, cap: true };

export function AutoReloadCard({ wallet, onTopUp }: { wallet: WalletState; onTopUp?: () => void }) {
	const save = useSetAutoReload();
	const runAction = useActionLock();
	const initialDraft = autoReloadDraftFromWallet(wallet);
	const [baseline, setBaseline] = useState<AutoReloadDraft>(initialDraft);
	const [draft, setDraft] = useState<AutoReloadDraft>(initialDraft);
	const [blurred, setBlurred] = useState<BlurredFields>(PRISTINE_FIELDS);
	const [requestError, setRequestError] = useState<AutoReloadSaveError | null>(null);
	const draftRef = useRef(draft);
	const baselineRef = useRef(baseline);
	const pendingRef = useRef(save.isPending);
	draftRef.current = draft;
	baselineRef.current = baseline;
	pendingRef.current = save.isPending;

	const form = autoReloadFormState({
		amount: draft.amount,
		threshold: draft.threshold,
		cap: draft.cap,
	});
	const dirty = autoReloadDraftIsDirty(draft, baseline);
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

	async function saveChanges() {
		const request = autoReloadRequest(draft);
		if (!dirty || !request || save.isPending) return;
		setRequestError(null);
		try {
			const nextWallet = await save.mutateAsync(request);
			const next = autoReloadDraftFromWallet(nextWallet);
			setBaseline(next);
			setDraft(next);
			setBlurred(PRISTINE_FIELDS);
			toast.success("Auto-reload settings saved", {
				description: next.enabled
					? "Auto-reload is on with the saved threshold, amount, and monthly cap."
					: "Auto-reload is off. Your saved parameters are ready for the next time you enable it.",
			});
		} catch (error) {
			const copy = autoReloadSaveError(error);
			setRequestError(copy);
			const field = copy.field;
			if (field) {
				setBlurred((current) => ({ ...current, [field]: true }));
				window.requestAnimationFrame(() => document.getElementById(`ar-${field}`)?.focus());
			}
			toast.error(copy.title, { description: copy.description });
		}
	}

	const thresholdInvalid = blurred.threshold && !form.thresholdValid;
	const amountInvalid = blurred.amount && !form.amountValid;
	const capInvalid = blurred.cap && !form.capValid;
	const thresholdServerError = requestError?.field === "threshold";
	const amountServerError = requestError?.field === "amount";
	const capServerError = requestError?.field === "cap";

	return (
		<Card data-hosted="true">
			<CardHeader>
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0">
						<CardTitle className="flex items-center gap-2 text-base">
							<Repeat className="size-4" aria-hidden /> Auto-reload
						</CardTitle>
						<CardDescription id="auto-reload-description">
							Top up automatically below a balance threshold. Changes apply only after you save.
						</CardDescription>
					</div>
					<div className="flex shrink-0 items-center gap-2">
						<Label htmlFor="auto-reload-enabled" className="text-sm">
							Enabled
						</Label>
						<Switch
							id="auto-reload-enabled"
							checked={draft.enabled}
							onCheckedChange={(enabled) => updateDraft("enabled", enabled)}
							disabled={save.isPending}
							aria-describedby="auto-reload-description"
						/>
					</div>
				</div>
			</CardHeader>

			<CardContent className="flex flex-col gap-4">
				<AutoReloadActionConfirm wallet={wallet} onTopUp={onTopUp} />

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
					onSubmit={(event) => {
						event.preventDefault();
						setBlurred(ALL_FIELDS_BLURRED);
						void runAction(saveChanges);
					}}
				>
					<div className="grid gap-4 sm:grid-cols-3">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="ar-threshold">When balance is below (USD)</Label>
							<Input
								id="ar-threshold"
								name="auto-reload-threshold"
								type="number"
								inputMode="decimal"
								autoComplete="off"
								min={AUTORELOAD_THRESHOLD_MIN_USD}
								step="0.01"
								className="tabular-nums"
								value={draft.threshold}
								onChange={(event) => updateDraft("threshold", event.target.value)}
								onBlur={() => markBlurred("threshold")}
								disabled={save.isPending}
								aria-invalid={thresholdInvalid || thresholdServerError}
								aria-describedby={
									thresholdServerError
										? "ar-threshold-help auto-reload-save-error"
										: "ar-threshold-help"
								}
							/>
							<p
								id="ar-threshold-help"
								className={
									thresholdInvalid ? "text-xs text-destructive" : "text-xs text-muted-foreground"
								}
								aria-live="polite"
							>
								Minimum {formatCents(AUTORELOAD_THRESHOLD_MIN_USD * 100)}; up to 2 decimal places.
							</p>
						</div>

						<div className="flex flex-col gap-1.5">
							<Label htmlFor="ar-amount">Amount to add (USD)</Label>
							<Input
								id="ar-amount"
								name="auto-reload-amount"
								type="number"
								inputMode="decimal"
								autoComplete="off"
								min={AUTORELOAD_AMOUNT_MIN_CENTS / 100}
								max={AUTORELOAD_AMOUNT_MAX_CENTS / 100}
								step="0.01"
								className="tabular-nums"
								value={draft.amount}
								onChange={(event) => updateDraft("amount", event.target.value)}
								onBlur={() => markBlurred("amount")}
								disabled={save.isPending}
								aria-invalid={amountInvalid || amountServerError}
								aria-describedby={
									amountServerError ? "ar-amount-help auto-reload-save-error" : "ar-amount-help"
								}
							/>
							<p
								id="ar-amount-help"
								className={
									amountInvalid ? "text-xs text-destructive" : "text-xs text-muted-foreground"
								}
								aria-live="polite"
							>
								$5–$500; up to 2 decimal places.
							</p>
						</div>

						<div className="flex flex-col gap-1.5">
							<Label htmlFor="ar-cap">Monthly cap (USD)</Label>
							<Input
								id="ar-cap"
								name="auto-reload-monthly-cap"
								type="number"
								inputMode="decimal"
								autoComplete="off"
								min={0}
								step="0.01"
								className="tabular-nums"
								value={draft.cap}
								onChange={(event) => updateDraft("cap", event.target.value)}
								onBlur={() => markBlurred("cap")}
								disabled={save.isPending}
								aria-invalid={capInvalid || capServerError}
								aria-describedby={
									capServerError ? "ar-cap-help auto-reload-save-error" : "ar-cap-help"
								}
							/>
							<p
								id="ar-cap-help"
								className={
									capInvalid ? "text-xs text-destructive" : "text-xs text-muted-foreground"
								}
								aria-live="polite"
							>
								Enter 0 for no monthly cap; up to 2 decimal places.
							</p>
						</div>
					</div>
				</form>
			</CardContent>

			<CardFooter className="flex flex-wrap justify-between gap-3 border-t">
				<div className="flex min-w-0 flex-col gap-1">
					<p className="text-xs text-muted-foreground">
						Enabling requires a saved card. Your first manual top-up saves one.
					</p>
					<p
						className={
							dirty
								? "text-xs font-medium text-warning-muted-foreground"
								: "text-xs text-muted-foreground"
						}
						aria-live="polite"
					>
						{dirty ? "Unsaved changes" : "All changes saved"}
					</p>
				</div>
				<div className="flex gap-2">
					<Button
						type="button"
						size="sm"
						variant="ghost"
						onClick={cancelChanges}
						disabled={!dirty || save.isPending}
					>
						Cancel changes
					</Button>
					<Button
						type="submit"
						form="auto-reload-form"
						size="sm"
						disabled={!dirty || !form.formValid || save.isPending}
					>
						{save.isPending ? (
							<>
								<Spinner data-icon="inline-start" /> Saving…
							</>
						) : (
							"Save changes"
						)}
					</Button>
				</div>
			</CardFooter>
		</Card>
	);
}
