"use client";

import { CreditCard, Pencil } from "lucide-react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { SettingsSection } from "@/components/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { billingErrorNormalizer } from "@/hosted/billing/errors";
import { useWalletPaymentMethods } from "@/hosted/billing/hooks";

export function PaymentMethodsSection({
	onManage,
	managing,
}: {
	onManage: () => void;
	managing: boolean;
}) {
	const methods = useWalletPaymentMethods();
	return (
		<SettingsSection
			id="payment-methods"
			data-hosted="true"
			headingLevel={3}
			title="Payment methods"
			description="Cards saved to your billing account."
			actions={
				<Button
					variant="outline"
					size="sm"
					onClick={onManage}
					disabled={managing}
					aria-busy={managing}
					aria-label="Edit payment methods"
				>
					{managing ? <Spinner /> : <Pencil aria-hidden />} Edit
				</Button>
			}
		>
			<div className="space-y-3">
				{methods.isLoading ? (
					<Skeleton className="h-16 w-full" />
				) : methods.error ? (
					<ApiErrorPanel
						error={methods.error}
						normalizer={billingErrorNormalizer}
						onRetry={() => void methods.refetch()}
						title="Couldn’t load saved cards"
					/>
				) : methods.data?.items.length ? (
					<ul className="divide-y rounded-lg border">
						{methods.data.items.map((method) => (
							<li key={method.id} className="flex flex-wrap items-center gap-3 p-3">
								<CreditCard aria-hidden className="size-4 text-muted-foreground" />
								<div className="min-w-0 flex-1">
									<p className="text-sm font-medium capitalize">
										{method.card.brand} ending in {method.card.last4}
									</p>
									<p className="text-xs text-muted-foreground">
										Expires {String(method.card.exp_month).padStart(2, "0")}/{method.card.exp_year}
									</p>
								</div>
								{method.is_default ? <Badge variant="outline">Billing default</Badge> : null}
								{method.is_auto_reload ? <Badge variant="outline">Auto-reload</Badge> : null}
							</li>
						))}
					</ul>
				) : (
					<p className="text-sm text-muted-foreground">No saved cards yet.</p>
				)}
				{methods.data?.has_more ? (
					<p className="text-xs text-muted-foreground">
						Additional saved cards are not shown here.
					</p>
				) : null}
				<p className="text-xs text-muted-foreground">
					Auto-reload uses the card selected in Auto-reload below.
				</p>
			</div>
		</SettingsSection>
	);
}
