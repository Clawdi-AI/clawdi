"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { IS_HOSTED } from "@/lib/hosted";
import { cn } from "@/lib/utils";

/**
 * Secondary tab bar for the nested billing surfaces, rendered inside the
 * Settings content column above the active billing page. Hosted-only — it
 * returns `null` in OSS builds so the route (which renders no content there)
 * shows nothing rather than an empty tab strip.
 */
const BILLING_TABS = [
	{ href: "/settings/billing/wallet", label: "Wallet" },
	{ href: "/settings/billing/plan", label: "Plan" },
	{ href: "/settings/billing/usage", label: "Usage" },
];

export function BillingTabsNav() {
	const pathname = usePathname();
	if (!IS_HOSTED) return null;

	return (
		<div className="px-4 lg:px-6">
			<nav className="flex gap-1 overflow-x-auto border-b" aria-label="Billing sections">
				{BILLING_TABS.map((tab) => {
					const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
					return (
						<Link
							key={tab.href}
							href={tab.href}
							aria-current={active ? "page" : undefined}
							className={cn(
								"-mb-px shrink-0 border-b-2 px-3 py-2 text-sm transition-colors",
								active
									? "border-primary font-medium text-foreground"
									: "border-transparent text-muted-foreground hover:text-foreground",
							)}
						>
							{tab.label}
						</Link>
					);
				})}
			</nav>
		</div>
	);
}
