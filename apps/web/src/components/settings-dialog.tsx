"use client";

import { settingsDialogClasses } from "@clawdi/shared/ui";

import type { AgentTile } from "@clawdi/shared/view";
import type { ShouldBlockFn } from "@tanstack/react-router";
import {
	BarChart3,
	CreditCard,
	Key,
	type LucideIcon,
	SlidersHorizontal,
	WalletCards,
	XIcon,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { type ApiErrorNormalizer, ApiErrorPanel } from "@/components/api-error-panel";
import { IconChip } from "@/components/icon-chip";
import { RouteLoadingSkeleton } from "@/components/route-loading-skeleton";
import { ApiKeysPanel } from "@/components/settings/api-keys-panel";
import { GeneralPanel } from "@/components/settings/general-panel";
import { type SettingsEditState, SettingsEditStateContext } from "@/components/settings-edit-state";
import { SettingsPanelErrorBoundary } from "@/components/settings-panel-error-boundary";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { UnsavedNavigationGuard } from "@/components/unsaved-navigation-guard";
import { useProductAccess } from "@/lib/product-access";
import {
	DEFAULT_SETTINGS_SECTION,
	SETTINGS_SECTION_IDS,
	type SettingsSectionId,
	settingsDraftOwnerChanges,
	shouldCanonicalizeCloudSettings,
} from "@/lib/settings-routes";
import { cn } from "@/lib/utils";

const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";

const HOSTED_ACCESS_ERROR_NORMALIZER: ApiErrorNormalizer = {
	isAuthError: () => false,
	normalizeError: () => "Check your connection, then retry the billing access check.",
};

const WalletPage = IS_HOSTED_BUILD
	? lazy(() =>
			import("@/hosted/billing/wallet/wallet-page").then((m) => ({ default: m.WalletPage })),
		)
	: null;

const SubscriptionPage = IS_HOSTED_BUILD
	? lazy(() =>
			import("@/hosted/billing/subscription/subscription-page").then((m) => ({
				default: m.SubscriptionPage,
			})),
		)
	: null;

const UsagePage = IS_HOSTED_BUILD
	? lazy(() => import("@/hosted/billing/usage/usage-page").then((m) => ({ default: m.UsagePage })))
	: null;

type SettingsNavItem = {
	id: SettingsSectionId;
	label: string;
	description: string;
	icon: LucideIcon;
	cloudOnly?: boolean;
};

const SETTINGS_NAV: SettingsNavItem[] = [
	{
		id: "general",
		label: "General",
		description: "Account and appearance",
		icon: SlidersHorizontal,
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
		description: "Balance, top-ups, and payment methods",
		icon: WalletCards,
		cloudOnly: true,
	},
	{
		id: "billing-plan",
		label: "Compute",
		description: "Subscriptions and plans",
		icon: CreditCard,
		cloudOnly: true,
	},
	{
		id: "billing-usage",
		label: "AI Usage",
		description: "LLM spend in USD, paid from wallet",
		icon: BarChart3,
		cloudOnly: true,
	},
];

export function SettingsDialog({
	open,
	section,
	agentTiles,
	hasExistingCloudAgents = false,
	cloudInventoryResolved = true,
	onSectionChange,
	onOpenChange,
}: {
	open: boolean;
	section: SettingsSectionId;
	agentTiles: readonly AgentTile[];
	hasExistingCloudAgents?: boolean;
	cloudInventoryResolved?: boolean;
	onSectionChange: (section: SettingsSectionId) => void;
	onOpenChange: (open: boolean) => void;
}) {
	const activeButtonRef = useRef<HTMLButtonElement | null>(null);
	const hostedAccess = useProductAccess();
	const [mounted, setMounted] = useState(false);
	const [editStates, setEditStates] = useState<Map<symbol, SettingsEditState>>(() => new Map());
	const registerEditState = useCallback((token: symbol, state: SettingsEditState | null) => {
		setEditStates((current) => {
			const next = new Map(current);
			if (state && (state.dirty || state.busy)) next.set(token, state);
			else next.delete(token);
			return next;
		});
	}, []);
	const hasUnsavedChanges = [...editStates.values()].some((state) => state.dirty);
	const hasPendingSave = [...editStates.values()].some((state) => state.busy);
	const shouldBlockNavigation: ShouldBlockFn = useCallback(
		({ current, next }) => settingsDraftOwnerChanges(current, next),
		[],
	);
	useEffect(() => {
		setMounted(true);
	}, []);
	const requestedBillingSection = section.startsWith("billing-");
	const showBilling =
		IS_HOSTED_BUILD &&
		(hostedAccess.canCreateCloudAgents ||
			hasExistingCloudAgents ||
			(requestedBillingSection && (!mounted || hostedAccess.isLoading || hostedAccess.isError)));
	const items = SETTINGS_NAV.filter((item) => !item.cloudOnly || showBilling);
	const activeSection = items.some((item) => item.id === section)
		? section
		: DEFAULT_SETTINGS_SECTION;
	const billingAccessPending =
		requestedBillingSection &&
		IS_HOSTED_BUILD &&
		(!mounted || hostedAccess.isLoading || !cloudInventoryResolved);
	const billingAccessError =
		requestedBillingSection &&
		IS_HOSTED_BUILD &&
		mounted &&
		hostedAccess.isError &&
		!hostedAccess.canCreateCloudAgents &&
		!hasExistingCloudAgents;

	useEffect(() => {
		if (!open) return;
		const frame = window.requestAnimationFrame(() => {
			const activeButton = activeButtonRef.current;
			if (!activeButton) return;
			const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
			activeButton.scrollIntoView({
				behavior: reduceMotion ? "auto" : "smooth",
				block: "nearest",
				inline: "nearest",
			});
		});
		return () => window.cancelAnimationFrame(frame);
	}, [open, activeSection]);

	useEffect(() => {
		if (
			open &&
			mounted &&
			shouldCanonicalizeCloudSettings({
				section,
				accessLoading: hostedAccess.isLoading,
				accessError: hostedAccess.isError,
				canCreateCloudAgents: hostedAccess.canCreateCloudAgents,
				inventoryResolved: cloudInventoryResolved,
				hasExistingCloudAgents,
			})
		) {
			onSectionChange(DEFAULT_SETTINGS_SECTION);
		}
	}, [
		cloudInventoryResolved,
		hasExistingCloudAgents,
		hostedAccess.canCreateCloudAgents,
		hostedAccess.isError,
		hostedAccess.isLoading,
		mounted,
		onSectionChange,
		open,
		section,
	]);

	function requestClose(nextOpen: boolean) {
		onOpenChange(nextOpen);
	}

	function requestSectionChange(nextSection: SettingsSectionId) {
		if (nextSection === activeSection) return;
		onSectionChange(nextSection);
	}

	return (
		<SettingsEditStateContext.Provider value={registerEditState}>
			<Dialog open={open} onOpenChange={requestClose}>
				<DialogContent
					data-testid="settings-dialog"
					initialFocus={activeButtonRef}
					showCloseButton={false}
					className={settingsDialogClasses.dialog}
				>
					<div className={settingsDialogClasses.shell}>
						<DialogHeader className={settingsDialogClasses.header}>
							<DialogTitle className={settingsDialogClasses.title}>Settings</DialogTitle>
							<DialogDescription className={settingsDialogClasses.screenReader}>
								Account, billing, and application settings.
							</DialogDescription>
							{!hasPendingSave ? <SettingsDialogCloseButton /> : null}
						</DialogHeader>

						<div className={settingsDialogClasses.layout}>
							<aside className={settingsDialogClasses.navigation}>
								<div className={settingsDialogClasses.navigationContainer}>
									<nav
										aria-label="Settings sections"
										className={settingsDialogClasses.navigationItems}
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
													onClick={() => requestSectionChange(item.id)}
													className={cn(
														settingsDialogClasses.navigationButton,
														settingsDialogClasses.navigationActive,
													)}
												>
													<IconChip
														size="sm"
														tint={
															active
																? "bg-primary text-primary-foreground"
																: "bg-background text-foreground"
														}
													>
														<Icon />
													</IconChip>
													<span className={settingsDialogClasses.navigationCopy}>
														<span className={settingsDialogClasses.navigationLabel}>
															{item.label}
														</span>
														<span className={settingsDialogClasses.navigationDescription}>
															{item.description}
														</span>
													</span>
												</Button>
											);
										})}
									</nav>
									<div className={settingsDialogClasses.navigationFade} />
								</div>
							</aside>

							<section className={settingsDialogClasses.panel}>
								<div className={settingsDialogClasses.panelWidth}>
									{billingAccessPending ? (
										<RouteLoadingSkeleton />
									) : billingAccessError ? (
										<div className={settingsDialogClasses.panelPadding}>
											<ApiErrorPanel
												error={hostedAccess.error}
												normalizer={HOSTED_ACCESS_ERROR_NORMALIZER}
												onRetry={() => void hostedAccess.refetch()}
												title="Couldn’t verify billing access"
											/>
										</div>
									) : (
										<SettingsPanelErrorBoundary key={activeSection}>
											<SettingsPanel section={activeSection} agentTiles={agentTiles} />
										</SettingsPanelErrorBoundary>
									)}
								</div>
							</section>
						</div>
					</div>
				</DialogContent>
			</Dialog>

			<UnsavedNavigationGuard
				dirty={hasUnsavedChanges}
				busy={hasPendingSave}
				shouldBlockFn={shouldBlockNavigation}
				description="Your auto-reload settings will return to the last values saved on the server."
			/>
		</SettingsEditStateContext.Provider>
	);
}

function SettingsDialogCloseButton({ className }: { className?: string }) {
	return (
		<DialogClose
			className={className}
			render={<Button type="button" variant="ghost" size="icon-sm" />}
		>
			<XIcon />
			<span className={settingsDialogClasses.screenReader}>Close</span>
		</DialogClose>
	);
}

function SettingsPanel({
	section,
	agentTiles,
}: {
	section: SettingsSectionId;
	agentTiles: readonly AgentTile[];
}) {
	if (!SETTINGS_SECTION_IDS.includes(section)) return <GeneralPanel />;

	switch (section) {
		case "api-keys":
			return <ApiKeysPanel />;
		case "billing-wallet":
			return WalletPage ? (
				<Suspense fallback={<RouteLoadingSkeleton />}>
					<WalletPage />
				</Suspense>
			) : (
				<GeneralPanel />
			);
		case "billing-plan":
			return SubscriptionPage ? (
				<Suspense fallback={<RouteLoadingSkeleton />}>
					<SubscriptionPage agentTiles={agentTiles} />
				</Suspense>
			) : (
				<GeneralPanel />
			);
		case "billing-usage":
			return UsagePage ? (
				<Suspense fallback={<RouteLoadingSkeleton />}>
					<UsagePage agentTiles={agentTiles} />
				</Suspense>
			) : (
				<GeneralPanel />
			);
		default:
			return <GeneralPanel />;
	}
}
