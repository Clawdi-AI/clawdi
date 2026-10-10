"use client";
import { paymentMethodsSectionClasses } from "@clawdi/shared/ui";
import { billingCopy, paymentMethodPresentation, paymentMethodsCopy } from "@clawdi/shared/view";

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
			<div className={paymentMethodsSectionClasses.body}>
				{methods.isLoading ? (
					<Skeleton className={paymentMethodsSectionClasses.loading} />
				) : methods.error ? (
					<ApiErrorPanel
						error={methods.error}
						normalizer={billingErrorNormalizer}
						onRetry={() => void methods.refetch()}
						title={paymentMethodsCopy.error}
					/>
				) : methods.data?.items.length ? (
					<ul className={paymentMethodsSectionClasses.list}>
						{methods.data.items.map((method) => (
							<li key={method.id} className={paymentMethodsSectionClasses.item}>
								<CreditCard aria-hidden className={paymentMethodsSectionClasses.icon} />
								<div className={paymentMethodsSectionClasses.copy}>
									<p className={paymentMethodsSectionClasses.title}>
										{paymentMethodPresentation(method).title}
									</p>
									<p className={paymentMethodsSectionClasses.hint}>
										{paymentMethodPresentation(method).expires}
									</p>
								</div>
								{method.is_default ? (
									<Badge variant="outline">{paymentMethodsCopy.billingDefault}</Badge>
								) : null}
								{method.is_auto_reload ? (
									<Badge variant="outline">{paymentMethodsCopy.autoReload}</Badge>
								) : null}
							</li>
						))}
					</ul>
				) : (
					<p className={paymentMethodsSectionClasses.empty}>{paymentMethodsCopy.empty}</p>
				)}
				{methods.data?.has_more ? (
					<p className={paymentMethodsSectionClasses.hint}>{paymentMethodsCopy.more}</p>
				) : null}
				<p className={paymentMethodsSectionClasses.hint}>{billingCopy.autoReloadCardHint}</p>
			</div>
		</SettingsSection>
	);
}
