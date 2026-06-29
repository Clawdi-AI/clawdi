"use client";

import {
	BarChart3,
	CreditCard,
	Key,
	type LucideIcon,
	SlidersHorizontal,
	User,
	WalletCards,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { HostedRouteSkeleton } from "@/components/hosted-route-skeleton";
import { ApiKeysPanel } from "@/components/settings/api-keys-panel";
import { GeneralPanel } from "@/components/settings/general-panel";
import { ProfilePanel } from "@/components/settings/profile-panel";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import dynamic from "@/lib/dynamic";
import { IS_HOSTED } from "@/lib/hosted";
import {
	DEFAULT_SETTINGS_SECTION,
	SETTINGS_SECTION_IDS,
	type SettingsSectionId,
} from "@/lib/settings-routes";
import { cn } from "@/lib/utils";
import { useV2Access } from "@/lib/v2-access";

const WalletPage = IS_HOSTED
	? dynamic(
			() => import("@/hosted/billing/wallet/wallet-page").then((m) => ({ default: m.WalletPage })),
			{ loading: HostedRouteSkeleton },
		)
	: null;

const SubscriptionPage = IS_HOSTED
	? dynamic(
			() =>
				import("@/hosted/billing/subscription/subscription-page").then((m) => ({
					default: m.SubscriptionPage,
				})),
			{ loading: HostedRouteSkeleton },
		)
	: null;

const UsagePage = IS_HOSTED
	? dynamic(
			() => import("@/hosted/billing/usage/usage-page").then((m) => ({ default: m.UsagePage })),
			{ loading: HostedRouteSkeleton },
		)
	: null;

type SettingsNavItem = {
	id: SettingsSectionId;
	label: string;
	description: string;
	icon: LucideIcon;
	v2Only?: boolean;
};

const SETTINGS_NAV: SettingsNavItem[] = [
	{
		id: "general",
		label: "General",
		description: "Appearance and app preferences",
		icon: SlidersHorizontal,
	},
	{
		id: "profile",
		label: "Profile",
		description: "Account identity",
		icon: User,
	},
	{
		id: "api-keys",
		label: "API Keys",
		description: "CLI and server tokens",
		icon: Key,
	},
	{
		id: "billing-wallet",
		label: "Wallet",
		description: "Balance and top-ups",
		icon: WalletCards,
		v2Only: true,
	},
	{
		id: "billing-plan",
		label: "Compute",
		description: "Plans and new agents",
		icon: CreditCard,
		v2Only: true,
	},
	{
		id: "billing-usage",
		label: "Usage",
		description: "AI Credit consumption",
		icon: BarChart3,
		v2Only: true,
	},
];

export function SettingsDialog({
	open,
	section,
	onSectionChange,
	onOpenChange,
}: {
	open: boolean;
	section: SettingsSectionId;
	onSectionChange: (section: SettingsSectionId) => void;
	onOpenChange: (open: boolean) => void;
}) {
	const activeButtonRef = useRef<HTMLButtonElement | null>(null);
	const v2Access = useV2Access();
	const [mounted, setMounted] = useState(false);
	useEffect(() => {
		setMounted(true);
	}, []);
	const showBilling = mounted && IS_HOSTED && v2Access.canUseV2;
	const items = SETTINGS_NAV.filter((item) => !item.v2Only || showBilling);
	const activeSection = items.some((item) => item.id === section)
		? section
		: DEFAULT_SETTINGS_SECTION;

	useEffect(() => {
		if (!open) return;
		const frame = window.requestAnimationFrame(() => {
			activeButtonRef.current?.focus({ preventScroll: true });
		});
		return () => window.cancelAnimationFrame(frame);
	}, [open, activeSection]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					activeButtonRef.current?.focus({ preventScroll: true });
				}}
				className="h-[min(820px,calc(100dvh-2rem))] w-[calc(100vw-2rem)] max-w-6xl gap-0 overflow-hidden p-0 sm:max-w-6xl"
			>
				<DialogHeader className="sr-only">
					<DialogTitle>Settings</DialogTitle>
					<DialogDescription>Account, billing, and application settings.</DialogDescription>
				</DialogHeader>

				<div className="grid h-full min-h-0 grid-rows-[auto_1fr] md:grid-cols-[15rem_minmax(0,1fr)] md:grid-rows-1">
					<aside className="flex min-w-0 flex-col border-b bg-muted/30 md:border-r md:border-b-0">
						<div className="flex h-14 shrink-0 items-center px-4 md:h-16">
							<div className="min-w-0">
								<div className="truncate text-sm font-semibold">Settings</div>
								<div className="truncate text-xs text-muted-foreground">Clawdi preferences</div>
							</div>
						</div>
						<nav
							aria-label="Settings sections"
							className="flex gap-1 overflow-x-auto px-2 pb-2 md:min-h-0 md:flex-1 md:flex-col md:overflow-y-auto md:px-3 md:pb-3"
						>
							{items.map((item) => {
								const Icon = item.icon;
								const active = activeSection === item.id;
								return (
									<Button
										key={item.id}
										ref={active ? activeButtonRef : undefined}
										type="button"
										variant="ghost"
										aria-current={active ? "page" : undefined}
										data-active={active}
										onClick={() => onSectionChange(item.id)}
										className={cn(
											"h-auto min-w-44 shrink-0 justify-start gap-3 whitespace-normal rounded-md px-3 py-2 text-left text-sm text-muted-foreground hover:bg-background/70 hover:text-foreground md:min-w-0",
											"data-[active=true]:bg-background data-[active=true]:text-foreground data-[active=true]:shadow-xs",
										)}
									>
										<span
											className={cn(
												"flex size-8 shrink-0 items-center justify-center rounded-md",
												active
													? "bg-primary text-primary-foreground"
													: "bg-background text-foreground",
											)}
										>
											<Icon />
										</span>
										<span className="grid min-w-0 flex-1 leading-tight">
											<span className="truncate font-medium">{item.label}</span>
											<span className="truncate text-xs text-muted-foreground">
												{item.description}
											</span>
										</span>
									</Button>
								);
							})}
						</nav>
					</aside>

					<section className="min-h-0 overflow-y-auto py-6 md:py-8">
						<div className="mx-auto w-full max-w-5xl">
							<SettingsPanel section={activeSection} />
						</div>
					</section>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function SettingsPanel({ section }: { section: SettingsSectionId }) {
	if (!SETTINGS_SECTION_IDS.includes(section)) return <GeneralPanel />;

	switch (section) {
		case "profile":
			return <ProfilePanel />;
		case "api-keys":
			return <ApiKeysPanel />;
		case "billing-wallet":
			return WalletPage ? <WalletPage /> : <GeneralPanel />;
		case "billing-plan":
			return SubscriptionPage ? <SubscriptionPage /> : <GeneralPanel />;
		case "billing-usage":
			return UsagePage ? <UsagePage /> : <GeneralPanel />;
		default:
			return <GeneralPanel />;
	}
}
