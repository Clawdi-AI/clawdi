"use client";

import { CreditCard, Key, type LucideIcon, SlidersHorizontal, User } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { IS_HOSTED } from "@/lib/hosted";
import { cn } from "@/lib/utils";

/**
 * Routed settings chrome — a left sub-nav plus a content column, replacing
 * the old settings modal. General/Profile/API Keys ship in every build;
 * AI Providers and Billing are hosted-only surfaces gated by `IS_HOSTED`
 * (OSS builds never render those nav items or routes).
 *
 * The shell owns no horizontal content padding: each panel (and the nested
 * billing pages) carries its own `px-4 lg:px-6`, so a hosted billing page
 * reused verbatim lines up with the General panel without edits.
 */

interface SettingsNavItem {
	href: string;
	label: string;
	icon: LucideIcon;
	/** Active when the pathname starts with this prefix (sections with
	 *  sub-routes, e.g. Billing). Defaults to an exact href match. */
	prefix?: string;
	hosted?: boolean;
}

const SETTINGS_NAV: SettingsNavItem[] = [
	{ href: "/settings/general", label: "General", icon: SlidersHorizontal },
	{ href: "/settings/profile", label: "Profile", icon: User },
	{ href: "/settings/api-keys", label: "API Keys", icon: Key },
	{
		href: "/settings/billing",
		label: "Billing",
		icon: CreditCard,
		prefix: "/settings/billing",
		hosted: true,
	},
];

export function SettingsShell({ children }: { children: ReactNode }) {
	const pathname = usePathname();
	const items = SETTINGS_NAV.filter((item) => IS_HOSTED || !item.hosted);

	return (
		<div className="flex flex-col gap-3 md:flex-row md:gap-2 lg:gap-6">
			<nav
				aria-label="Settings sections"
				className="flex shrink-0 gap-1 overflow-x-auto px-4 lg:px-6 md:w-56 md:flex-col md:overflow-x-visible md:pr-0"
			>
				{items.map((item) => {
					const active = item.prefix ? pathname.startsWith(item.prefix) : pathname === item.href;
					return (
						<Link
							key={item.href}
							href={item.href}
							aria-current={active ? "page" : undefined}
							className={cn(
								"flex shrink-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors",
								active
									? "bg-accent font-medium text-accent-foreground"
									: "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
							)}
						>
							<item.icon className="size-4 shrink-0" />
							{item.label}
						</Link>
					);
				})}
			</nav>

			<div className="min-w-0 flex-1 pb-6">{children}</div>
		</div>
	);
}

/**
 * Per-panel header (title + optional description and action slot), sized
 * for a routed settings page. Shared by every settings panel — including
 * the hosted AI Providers surface — so headings stay consistent.
 */
export function SettingsPanelHeader({
	title,
	description,
	actions,
}: {
	title: string;
	description?: ReactNode;
	actions?: ReactNode;
}) {
	return (
		<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
			<div className="min-w-0 space-y-1">
				<h2 className="text-lg font-semibold tracking-tight">{title}</h2>
				{description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
			</div>
			{actions ? (
				<div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0 sm:justify-end">
					{actions}
				</div>
			) : null}
		</div>
	);
}
