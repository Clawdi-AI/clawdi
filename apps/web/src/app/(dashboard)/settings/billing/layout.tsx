import { pageMetadata } from "@/app/page-metadata";
import { HostedV2Gate } from "@/components/hosted-v2-gate";
import { BillingTabsNav } from "@/components/settings/billing-tabs-nav";

export const metadata = pageMetadata("Billing", "Wallet, plan, and usage for your hosted agents.");

export default function BillingLayout({ children }: { children: React.ReactNode }) {
	return (
		<HostedV2Gate fallbackHref="/settings/general">
			<div className="space-y-6">
				<BillingTabsNav />
				{children}
			</div>
		</HostedV2Gate>
	);
}
