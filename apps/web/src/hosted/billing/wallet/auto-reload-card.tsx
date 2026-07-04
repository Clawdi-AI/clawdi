"use client";

import { Repeat } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import type { WalletState } from "@/hosted/billing/contracts";
import { normalizeBillingError } from "@/hosted/billing/errors";
import { useSetAutoReload } from "@/hosted/billing/hooks";
import { AutoReloadActionConfirm } from "@/hosted/billing/wallet/auto-reload-action";
import {
	AUTORELOAD_AMOUNT_MAX_CENTS,
	AUTORELOAD_AMOUNT_MIN_CENTS,
	AUTORELOAD_THRESHOLD_MIN_CREDITS,
} from "@/hosted/billing/wallet/wallet-constants";

function dollars(n: number): string {
	// Preserve cents (e.g. 7.5, 1.25) — rounding to whole dollars silently
	// misrepresented a saved threshold/amount when the user reopened the card.
	return String(Math.round(n * 100) / 100);
}

export function AutoReloadCard({ wallet, onTopUp }: { wallet: WalletState; onTopUp?: () => void }) {
	const save = useSetAutoReload();
	const pointsPerUsd = wallet.points_per_usd || 1000;

	const [enabled, setEnabled] = useState(wallet.auto_reload_enabled);
	const [threshold, setThreshold] = useState(
		dollars(wallet.auto_reload_threshold_credits / pointsPerUsd),
	);
	const [amount, setAmount] = useState(dollars(wallet.auto_reload_amount_cents / 100));
	const [cap, setCap] = useState(dollars(wallet.auto_reload_monthly_cap_cents / 100));

	useEffect(() => {
		if (save.isPending) return;
		setEnabled(wallet.auto_reload_enabled);
		setThreshold(dollars(wallet.auto_reload_threshold_credits / pointsPerUsd));
		setAmount(dollars(wallet.auto_reload_amount_cents / 100));
		setCap(dollars(wallet.auto_reload_monthly_cap_cents / 100));
	}, [
		save.isPending,
		wallet.auto_reload_enabled,
		wallet.auto_reload_threshold_credits,
		wallet.auto_reload_amount_cents,
		wallet.auto_reload_monthly_cap_cents,
		pointsPerUsd,
	]);

	const amountCents = Math.round(Number(amount) * 100);
	const thresholdCredits = Math.round(Number(threshold) * pointsPerUsd);
	const capCents = Math.round(Number(cap) * 100);

	const amountValid =
		amountCents >= AUTORELOAD_AMOUNT_MIN_CENTS && amountCents <= AUTORELOAD_AMOUNT_MAX_CENTS;
	const thresholdValid = thresholdCredits >= AUTORELOAD_THRESHOLD_MIN_CREDITS;
	// 0 = no cap; any positive value is a cap. Negative / non-numeric is invalid.
	const capValid = Number.isFinite(capCents) && capCents >= 0;
	const formValid = amountValid && thresholdValid && capValid;

	async function persist(nextEnabled: boolean) {
		// Belt-and-braces against a double-fire while the switch/button repaint.
		if (save.isPending) return;
		if (nextEnabled && !formValid) return;
		try {
			await save.mutateAsync(
				nextEnabled
					? {
							auto_reload_enabled: true,
							auto_reload_threshold_credits: thresholdCredits,
							auto_reload_amount_cents: amountCents,
							auto_reload_monthly_cap_cents: capCents,
						}
					: { auto_reload_enabled: false },
			);
			setEnabled(nextEnabled);
			toast.success(nextEnabled ? "Auto-reload on" : "Auto-reload off");
		} catch (e) {
			// Re-sync the switch with the server's truth on failure.
			setEnabled(wallet.auto_reload_enabled);
			toast.error("Couldn’t update auto-reload", { description: normalizeBillingError(e) });
		}
	}

	return (
		<Card data-hosted="true">
			<CardHeader>
				<div className="flex items-start justify-between gap-3">
					<div>
						<CardTitle className="flex items-center gap-2 text-base">
							<Repeat className="size-4" /> Auto-reload
						</CardTitle>
						<CardDescription>
							Automatically top up when your balance drops below the threshold. Off by default.
						</CardDescription>
					</div>
					<Switch
						checked={enabled}
						onCheckedChange={(next) => persist(next)}
						disabled={save.isPending || (!enabled && !formValid)}
						aria-label="Enable auto-reload"
					/>
				</div>
			</CardHeader>
			<CardContent className="space-y-4">
				<AutoReloadActionConfirm wallet={wallet} onTopUp={onTopUp} />

				<div className="grid gap-4 sm:grid-cols-3">
					<div className="space-y-1.5">
						<Label htmlFor="ar-threshold">When below ($)</Label>
						<Input
							id="ar-threshold"
							name="ar-threshold"
							type="number"
							inputMode="decimal"
							autoComplete="off"
							min={1}
							step="1"
							className="tabular-nums"
							value={threshold}
							onChange={(e) => setThreshold(e.target.value)}
							aria-invalid={!thresholdValid}
							aria-describedby={!thresholdValid ? "ar-threshold-err" : undefined}
						/>
						{!thresholdValid ? (
							<p id="ar-threshold-err" className="text-xs text-destructive">
								Minimum $1.
							</p>
						) : null}
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="ar-amount">Add ($)</Label>
						<Input
							id="ar-amount"
							name="ar-amount"
							type="number"
							inputMode="decimal"
							autoComplete="off"
							min={AUTORELOAD_AMOUNT_MIN_CENTS / 100}
							max={AUTORELOAD_AMOUNT_MAX_CENTS / 100}
							step="1"
							className="tabular-nums"
							value={amount}
							onChange={(e) => setAmount(e.target.value)}
							aria-invalid={!amountValid}
							aria-describedby={!amountValid ? "ar-amount-err" : undefined}
						/>
						{!amountValid ? (
							<p id="ar-amount-err" className="text-xs text-destructive">
								$5–$500.
							</p>
						) : null}
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="ar-cap">Monthly cap ($)</Label>
						<Input
							id="ar-cap"
							name="ar-cap"
							type="number"
							inputMode="decimal"
							autoComplete="off"
							min={0}
							step="1"
							className="tabular-nums"
							value={cap}
							onChange={(e) => setCap(e.target.value)}
							aria-invalid={!capValid}
							aria-describedby={capValid ? undefined : "ar-cap-err"}
						/>
						{capValid ? (
							<p className="text-xs text-muted-foreground">0 = no cap.</p>
						) : (
							<p id="ar-cap-err" className="text-xs text-destructive">
								Enter 0 (no cap) or a positive amount.
							</p>
						)}
					</div>
				</div>

				<div className="flex flex-wrap items-center justify-between gap-2">
					<p className="text-xs text-muted-foreground">
						Enabling requires a saved card. Your first top-up saves one.
					</p>
					{enabled ? (
						<Button
							size="sm"
							variant="outline"
							onClick={() => persist(true)}
							disabled={!formValid || save.isPending}
						>
							{save.isPending ? (
								<>
									<Spinner /> Saving…
								</>
							) : (
								"Save changes"
							)}
						</Button>
					) : null}
				</div>
			</CardContent>
		</Card>
	);
}
