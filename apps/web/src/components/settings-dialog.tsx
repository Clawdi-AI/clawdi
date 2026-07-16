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
import {
	lazy,
	type MouseEvent as ReactMouseEvent,
	Suspense,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { type ApiErrorNormalizer, ApiErrorPanel } from "@/components/api-error-panel";
import { HostedRouteSkeleton } from "@/components/hosted-route-skeleton";
import { IconChip } from "@/components/icon-chip";
import { ApiKeysPanel } from "@/components/settings/api-keys-panel";
import { GeneralPanel } from "@/components/settings/general-panel";
import { ProfilePanel } from "@/components/settings/profile-panel";
import { type SettingsEditState, SettingsEditStateContext } from "@/components/settings-edit-state";
import { SettingsPanelErrorBoundary } from "@/components/settings-panel-error-boundary";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useHostedProductAccess } from "@/lib/hosted-product-access";
import {
	DEFAULT_SETTINGS_SECTION,
	SETTINGS_SECTION_IDS,
	type SettingsSectionId,
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

type PendingSettingsIntent =
	| { kind: "close" }
	| { kind: "section"; section: SettingsSectionId }
	| { kind: "navigate"; href: string };

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
		cloudOnly: true,
	},
	{
		id: "billing-plan",
		label: "Compute",
		description: "Plans and new agents",
		icon: CreditCard,
		cloudOnly: true,
	},
	{
		id: "billing-usage",
		label: "Usage",
		description: "AI Credits usage",
		icon: BarChart3,
		cloudOnly: true,
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
	const bypassUnloadRef = useRef(false);
	const hostedAccess = useHostedProductAccess();
	const [mounted, setMounted] = useState(false);
	const [editStates, setEditStates] = useState<Map<symbol, SettingsEditState>>(() => new Map());
	const [pendingIntent, setPendingIntent] = useState<PendingSettingsIntent | null>(null);
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
	useEffect(() => {
		setMounted(true);
	}, []);
	const requestedBillingSection = section.startsWith("billing-");
	const showBilling =
		IS_HOSTED_BUILD &&
		(hostedAccess.canCreateCloudAgents ||
			(requestedBillingSection &&
				(!mounted || hostedAccess.isLoading || Boolean(hostedAccess.error))));
	const items = SETTINGS_NAV.filter((item) => !item.cloudOnly || showBilling);
	const activeSection = items.some((item) => item.id === section)
		? section
		: DEFAULT_SETTINGS_SECTION;
	const billingAccessPending =
		requestedBillingSection && IS_HOSTED_BUILD && (!mounted || hostedAccess.isLoading);
	const billingAccessError =
		requestedBillingSection &&
		IS_HOSTED_BUILD &&
		mounted &&
		Boolean(hostedAccess.error) &&
		!hostedAccess.canCreateCloudAgents;

	useEffect(() => {
		if (!open) return;
		const frame = window.requestAnimationFrame(() => {
			activeButtonRef.current?.focus({ preventScroll: true });
		});
		return () => window.cancelAnimationFrame(frame);
	}, [open, activeSection]);

	useEffect(() => {
		if (!hasUnsavedChanges && !hasPendingSave) return;
		const warnBeforeUnload = (event: BeforeUnloadEvent) => {
			if (bypassUnloadRef.current) return;
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", warnBeforeUnload);
		return () => window.removeEventListener("beforeunload", warnBeforeUnload);
	}, [hasPendingSave, hasUnsavedChanges]);

	function requestClose(nextOpen: boolean) {
		if (nextOpen) {
			onOpenChange(true);
			return;
		}
		if (hasPendingSave) return;
		if (hasUnsavedChanges) {
			setPendingIntent({ kind: "close" });
			return;
		}
		onOpenChange(false);
	}

	function requestSectionChange(nextSection: SettingsSectionId) {
		if (nextSection === activeSection || hasPendingSave) return;
		if (hasUnsavedChanges) {
			setPendingIntent({ kind: "section", section: nextSection });
			return;
		}
		onSectionChange(nextSection);
	}

	function interceptNavigation(event: ReactMouseEvent<HTMLElement>) {
		if ((!hasUnsavedChanges && !hasPendingSave) || event.defaultPrevented) return;
		if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
			return;
		if (!(event.target instanceof Element)) return;
		const anchor = event.target.closest("a[href]");
		if (!(anchor instanceof HTMLAnchorElement)) return;
		if (anchor.target === "_blank" || anchor.hasAttribute("download")) return;
		const destination = new URL(anchor.href, window.location.href);
		const current = new URL(window.location.href);
		if (
			destination.origin === current.origin &&
			destination.pathname === current.pathname &&
			destination.search === current.search
		) {
			return;
		}

		event.preventDefault();
		if (!hasPendingSave) setPendingIntent({ kind: "navigate", href: destination.href });
	}

	function discardChanges() {
		const intent = pendingIntent;
		if (!intent) return;
		setPendingIntent(null);
		if (intent.kind === "close") {
			onOpenChange(false);
			return;
		}
		if (intent.kind === "section") {
			onSectionChange(intent.section);
			return;
		}
		bypassUnloadRef.current = true;
		window.location.assign(intent.href);
	}

	return (
		<SettingsEditStateContext.Provider value={registerEditState}>
			<Dialog open={open} onOpenChange={requestClose}>
				<DialogContent
					data-testid="settings-dialog"
					initialFocus={activeButtonRef}
					onClickCapture={interceptNavigation}
					showCloseButton={!hasPendingSave}
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
							<div className="relative min-w-0 md:min-h-0 md:flex-1">
								<nav
									aria-label="Settings sections"
									className="flex gap-1 overflow-x-auto px-3 pb-3 [scrollbar-width:thin] md:min-h-0 md:flex-1 md:flex-col md:overflow-y-auto md:px-3 md:pb-3"
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
													"h-auto min-w-28 shrink-0 justify-start gap-2 rounded-md px-2.5 py-2 text-left text-sm text-muted-foreground hover:bg-background/70 hover:text-foreground md:min-w-0 md:gap-3 md:px-3",
													"data-[active=true]:bg-background data-[active=true]:text-foreground data-[active=true]:shadow-xs",
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
												<span className="grid min-w-0 flex-1 leading-tight">
													<span className="truncate font-medium">{item.label}</span>
													<span className="hidden truncate text-xs text-muted-foreground md:block">
														{item.description}
													</span>
												</span>
											</Button>
										);
									})}
								</nav>
								<div className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-linear-to-l from-muted/30 to-transparent md:hidden" />
							</div>
						</aside>

						<section className="min-h-0 overflow-y-auto py-6 md:py-8">
							<div className="mx-auto w-full max-w-5xl">
								{billingAccessPending ? (
									<HostedRouteSkeleton />
								) : billingAccessError ? (
									<ApiErrorPanel
										error={hostedAccess.error}
										normalizer={HOSTED_ACCESS_ERROR_NORMALIZER}
										onRetry={() => void hostedAccess.refetch()}
										title="Couldn’t verify billing access"
									/>
								) : (
									<SettingsPanelErrorBoundary key={activeSection}>
										<SettingsPanel section={activeSection} />
									</SettingsPanelErrorBoundary>
								)}
							</div>
						</section>
					</div>
				</DialogContent>
			</Dialog>

			<AlertDialog
				open={pendingIntent !== null}
				onOpenChange={(nextOpen) => {
					if (!nextOpen) setPendingIntent(null);
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
						<AlertDialogDescription>
							Your auto-reload settings will return to the last values saved on the server.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Keep editing</AlertDialogCancel>
						<AlertDialogAction variant="destructive" onClick={discardChanges}>
							Discard changes
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</SettingsEditStateContext.Provider>
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
			return WalletPage ? (
				<Suspense fallback={<HostedRouteSkeleton />}>
					<WalletPage />
				</Suspense>
			) : (
				<GeneralPanel />
			);
		case "billing-plan":
			return SubscriptionPage ? (
				<Suspense fallback={<HostedRouteSkeleton />}>
					<SubscriptionPage />
				</Suspense>
			) : (
				<GeneralPanel />
			);
		case "billing-usage":
			return UsagePage ? (
				<Suspense fallback={<HostedRouteSkeleton />}>
					<UsagePage />
				</Suspense>
			) : (
				<GeneralPanel />
			);
		default:
			return <GeneralPanel />;
	}
}
