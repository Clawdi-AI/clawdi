import { pageMetadata } from "@/app/page-metadata";
import { BillingTabsNav } from "@/components/settings/billing-tabs-nav";

export const metadata = pageMetadata("Billing", "Wallet, plan, and usage for your hosted agents.");

export default function BillingLayout({ children }: { children: React.ReactNode }) {
	return (
		<div className="space-y-6">
			<BillingTabsNav />
			{children}
		</div>
	);
}
