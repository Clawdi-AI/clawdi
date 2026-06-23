import { pageMetadata } from "@/app/page-metadata";
import { BillingTabsNav } from "@/components/settings/billing-tabs-nav";
import { V2Gate } from "@/components/v2-gate";

export const metadata = pageMetadata("Billing", "Wallet, plan, and usage for your hosted agents.");

export default function BillingLayout({ children }: { children: React.ReactNode }) {
	return (
		<V2Gate fallbackHref="/settings/general">
			<div className="space-y-6">
				<BillingTabsNav />
				{children}
			</div>
		</V2Gate>
	);
}
