"use client";

import { Check, Gift, Mail, Share2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CopyButton } from "@/hosted/billing/components/copy-button";
import { BillingEmpty, BillingError } from "@/hosted/billing/components/state-views";
import { formatCredits } from "@/hosted/billing/format";
import { useMyReferrals, useReferralCode, useReferralRewards } from "@/hosted/billing/hooks";

const SHARE_TEXT =
	"I’m running always-on AI agents on Clawdi. Join with my link and we both earn AI Credits:";

export function ReferralCard() {
	const codeQuery = useReferralCode();
	const rewards = useReferralRewards();
	const referrals = useMyReferrals();

	const maxReward = Math.max(0, ...(rewards.data?.tiers.map((t) => t.reward_credits) ?? [0]));
	const url = codeQuery.data?.url ?? "";

	function openShareIntent() {
		const intent = `https://twitter.com/intent/tweet?text=${encodeURIComponent(SHARE_TEXT)}&url=${encodeURIComponent(url)}`;
		window.open(intent, "_blank", "noopener,noreferrer");
	}

	async function share() {
		if (!url) return;
		// Native share sheet on mobile / supported browsers; otherwise open an
		// X (Twitter) compose intent in a new tab.
		if (typeof navigator !== "undefined" && "share" in navigator) {
			try {
				await navigator.share({ title: "Clawdi", text: SHARE_TEXT, url });
				return;
			} catch (error) {
				if (error instanceof DOMException && error.name === "AbortError") {
					return;
				}
				openShareIntent();
				return;
			}
		}
		openShareIntent();
	}

	const mailtoHref = `mailto:?subject=${encodeURIComponent("Join me on Clawdi")}&body=${encodeURIComponent(`${SHARE_TEXT}\n\n${url}`)}`;

	return (
		<Card data-hosted="true">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-base">
					<Gift className="size-4" aria-hidden /> Refer a friend
				</CardTitle>
				<CardDescription>
					{maxReward > 0
						? `Earn up to ${formatCredits(maxReward)} when a friend you refer subscribes.`
						: "Share your link and earn AI Credits when friends join."}
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{rewards.error ? (
					<BillingError
						error={rewards.error}
						onRetry={() => rewards.refetch()}
						title="Couldn’t load reward tiers"
					/>
				) : null}
				{codeQuery.isLoading ? (
					<Skeleton className="h-9 w-full rounded-md" />
				) : codeQuery.error ? (
					<BillingError error={codeQuery.error} onRetry={() => codeQuery.refetch()} />
				) : codeQuery.data ? (
					<>
						<div className="flex items-center gap-2 rounded-md border bg-muted/40 p-2">
							<code className="min-w-0 flex-1 truncate font-mono text-xs">
								{codeQuery.data.url}
							</code>
							<CopyButton
								value={codeQuery.data.url}
								label="Copy referral link"
								toastMessage="Referral link copied"
							/>
						</div>
						<div className="flex flex-wrap gap-2">
							<Button size="sm" variant="outline" onClick={share}>
								<Share2 /> Share
							</Button>
							<Button asChild size="sm" variant="outline">
								<a href={mailtoHref}>
									<Mail /> Email
								</a>
							</Button>
						</div>
						<div className="flex items-center gap-6 text-sm">
							<div className="flex items-center gap-1.5">
								<Users className="size-4 text-muted-foreground" aria-hidden />
								<span className="font-medium tabular-nums">{codeQuery.data.total_referrals}</span>
								<span className="text-muted-foreground">referred</span>
							</div>
							<div className="flex items-center gap-1.5">
								<Check className="size-4 text-success" aria-hidden />
								<span className="font-medium tabular-nums">
									{codeQuery.data.converted_referrals}
								</span>
								<span className="text-muted-foreground">converted</span>
							</div>
						</div>
					</>
				) : (
					<BillingEmpty title="Referral link unavailable" description="Try again in a moment." />
				)}

				{referrals.error ? (
					<BillingError
						error={referrals.error}
						onRetry={() => referrals.refetch()}
						title="Couldn’t load referrals"
					/>
				) : null}
				{referrals.data && referrals.data.items.length > 0 ? (
					<div className="space-y-1.5">
						<p className="text-xs font-medium text-muted-foreground">Recent referrals</p>
						<ul className="divide-y rounded-md border">
							{referrals.data.items.slice(0, 5).map((item) => (
								<li
									key={item.referral_attribution_id}
									className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
								>
									<span className="truncate">{item.referred_user_label ?? "Pending sign-up"}</span>
									<span className="shrink-0 text-muted-foreground tabular-nums">
										{item.reward_credits_granted
											? `+${formatCredits(item.reward_credits_granted)}`
											: item.status}
									</span>
								</li>
							))}
						</ul>
						{referrals.data.total_referrals > 5 ? (
							<p className="text-xs text-muted-foreground">
								Showing your 5 most recent of {referrals.data.total_referrals} referrals.
							</p>
						) : null}
					</div>
				) : null}
			</CardContent>
		</Card>
	);
}
