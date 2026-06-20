"use client";

import { Check, Gift, Ticket, TriangleAlert } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import type { RedeemPreview } from "@/hosted/billing/contracts";
import {
	isInvalidTurnstileTokenError,
	isTurnstileRequiredError,
	normalizeBillingError,
} from "@/hosted/billing/errors";
import { formatCredits } from "@/hosted/billing/format";
import { useRedeem, useRedeemPreview } from "@/hosted/billing/hooks";
import { newIdempotencyKey } from "@/hosted/billing/idempotency";
import { TurnstileWidget } from "@/hosted/billing/rewards/turnstile-widget";
import { useActionLock } from "@/hosted/billing/use-action-lock";

/** Upper bound for a redemption code field — generous, but stops paste-bombs. */
const CODE_MAX_LENGTH = 64;

function previewSummary(preview: RedeemPreview): string {
	if (preview.duration_months && preview.plan_name) {
		const months = preview.duration_months;
		return `${preview.plan_name} for ${months} month${months === 1 ? "" : "s"}`;
	}
	if (preview.allowance_credits) {
		return `${formatCredits(preview.allowance_credits)} added to your wallet`;
	}
	return "This code is valid.";
}

/** Map the backend's machine reason codes to friendly, recoverable copy. */
function reasonMessage(reason: string | null): string {
	switch (reason) {
		case "code_not_found":
		case "not_found":
		case "invalid_code":
			return "We couldn’t find that code. Double-check it and try again.";
		case "expired":
			return "This code has expired.";
		case "already_redeemed":
		case "redeemed":
			return "This code has already been redeemed.";
		case "usage_limit_reached":
		case "limit_reached":
			return "This code has reached its redemption limit.";
		case "not_eligible":
		case "ineligible":
			return "Your account isn’t eligible for this code.";
		case null:
			return "This code can’t be redeemed.";
		default:
			return reason.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
	}
}

export function RedeemCard() {
	const previewMut = useRedeemPreview();
	const redeemMut = useRedeem();
	const runAction = useActionLock();
	const [code, setCode] = useState("");
	const codeRef = useRef("");
	const [preview, setPreview] = useState<RedeemPreview | null>(null);
	const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
	const [needsTurnstile, setNeedsTurnstile] = useState(false);
	const pendingAction = useRef<"check" | "redeem" | null>(null);
	const checkRequestRef = useRef(0);
	// One idempotency key per redeem ATTEMPT — reused across a Turnstile retry so
	// the server collapses the duplicate instead of applying the reward twice.
	const redeemKeyRef = useRef<string | null>(null);

	// The backend only enforces Turnstile after repeated invalid attempts; when
	// it does, surface a challenge and re-run the attempt with a fresh token.
	function handleTurnstile(e: unknown): boolean {
		if (isTurnstileRequiredError(e) || isInvalidTurnstileTokenError(e)) {
			setNeedsTurnstile(true);
			setTurnstileToken(null);
			toast.message("Quick verification", {
				description: "Confirm you’re human to continue.",
			});
			return true;
		}
		return false;
	}

	async function runCheck(token?: string | null) {
		const trimmed = code.trim();
		if (!trimmed) return;
		const requestId = ++checkRequestRef.current;
		setPreview(null);
		pendingAction.current = "check";
		try {
			const result = await previewMut.mutateAsync({
				code: trimmed,
				turnstile_token: token ?? turnstileToken ?? null,
			});
			if (checkRequestRef.current !== requestId || codeRef.current.trim() !== trimmed) return;
			setPreview(result);
			setNeedsTurnstile(false);
			pendingAction.current = null;
		} catch (e) {
			if (handleTurnstile(e)) return;
			// Real failure (not a Turnstile gate) — clear the pending marker so a
			// later challenge token can't replay this stale attempt.
			pendingAction.current = null;
			toast.error("Couldn’t check that code", { description: normalizeBillingError(e) });
		}
	}

	async function runRedeem(token?: string | null) {
		const trimmed = code.trim();
		if (!trimmed) return;
		pendingAction.current = "redeem";
		redeemKeyRef.current ??= newIdempotencyKey("redeem");
		try {
			const result = await redeemMut.mutateAsync({
				body: { code: trimmed, turnstile_token: token ?? turnstileToken ?? null },
				idempotencyKey: redeemKeyRef.current,
			});
			toast.success("Code redeemed", {
				description: result.deployment_queued
					? "Your reward is applied and your agent is deploying."
					: "Your reward has been applied.",
			});
			setCode("");
			codeRef.current = "";
			setPreview(null);
			setNeedsTurnstile(false);
			setTurnstileToken(null);
			pendingAction.current = null;
			redeemKeyRef.current = null;
		} catch (e) {
			// Turnstile gate → keep the key so the retry collapses server-side.
			if (handleTurnstile(e)) return;
			pendingAction.current = null;
			redeemKeyRef.current = null;
			toast.error("Couldn’t redeem that code", { description: normalizeBillingError(e) });
		}
	}

	// Keep refs to the latest closures so the stable Turnstile callback can
	// re-run the pending attempt with the freshly-minted token.
	const runCheckRef = useRef(runCheck);
	const runRedeemRef = useRef(runRedeem);
	runCheckRef.current = runCheck;
	runRedeemRef.current = runRedeem;

	const onTurnstileToken = useCallback((token: string) => {
		setTurnstileToken(token || null);
		if (!token) return;
		if (pendingAction.current === "redeem") runRedeemRef.current(token);
		else runCheckRef.current(token);
	}, []);

	const invalid = preview != null && !preview.valid;
	const busy = previewMut.isPending || redeemMut.isPending;

	return (
		<Card data-hosted="true">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-base">
					<Ticket className="size-4" /> Redeem a code
				</CardTitle>
				<CardDescription>
					Time codes add Performance; credit codes top up your AI Credits wallet.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-3">
				<div className="space-y-1.5">
					<Label htmlFor="redeem-code">Code</Label>
					<div className="flex gap-2">
						<Input
							id="redeem-code"
							value={code}
							onChange={(e) => {
								codeRef.current = e.target.value;
								checkRequestRef.current += 1;
								setCode(e.target.value);
								setPreview(null);
								setNeedsTurnstile(false);
								setTurnstileToken(null);
								pendingAction.current = null;
								redeemKeyRef.current = null;
							}}
							placeholder="CLAWDI-XXXX-XXXX"
							autoComplete="off"
							maxLength={CODE_MAX_LENGTH}
							spellCheck={false}
							onKeyDown={(e) => {
								if (e.key === "Enter") runAction(() => runCheck());
							}}
						/>
						<Button
							variant="outline"
							onClick={() => runAction(() => runCheck())}
							disabled={!code.trim() || busy}
						>
							{previewMut.isPending ? (
								<>
									<Spinner /> Checking…
								</>
							) : (
								"Check"
							)}
						</Button>
					</div>
				</div>

				{needsTurnstile ? <TurnstileWidget onToken={onTurnstileToken} /> : null}

				{preview ? (
					invalid ? (
						<p className="flex items-start gap-2 text-sm text-destructive">
							<TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
							<span>{reasonMessage(preview.reason)}</span>
						</p>
					) : (
						<div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between">
							<div className="flex items-center gap-2 text-sm">
								<Gift className="size-4 shrink-0 text-primary" aria-hidden />
								{previewSummary(preview)}
							</div>
							<Button
								onClick={() => runAction(() => runRedeem())}
								disabled={busy}
								className="w-full sm:w-auto"
							>
								{redeemMut.isPending ? (
									<>
										<Spinner /> Redeeming…
									</>
								) : (
									<>
										<Check /> Redeem
									</>
								)}
							</Button>
						</div>
					)
				) : null}
			</CardContent>
		</Card>
	);
}
