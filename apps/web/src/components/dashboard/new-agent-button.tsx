"use client";

import { useRouter } from "@tanstack/react-router";
import { CirclePlus, Loader2, Rocket, TerminalSquare } from "lucide-react";
import { useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { AddAgentDialog } from "@/components/dashboard/add-agent-dialog";
import { IconChip } from "@/components/icon-chip";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDesktopBridge } from "@/lib/desktop";
import { IS_HOSTED } from "@/lib/hosted";
import { useProductAccess } from "@/lib/product-access";
import { useHydrated } from "@/lib/use-hydrated";
import { cn } from "@/lib/utils";

export function NewAgentButton({
	compact = false,
	showTooltip = true,
	onNavigate,
	className,
}: {
	compact?: boolean;
	showTooltip?: boolean;
	onNavigate?: () => void;
	className?: string;
} = {}) {
	const router = useRouter();
	const desktopBridge = useDesktopBridge();
	const hostedAccess = useProductAccess();
	const hydrated = useHydrated();
	const [chooserOpen, setChooserOpen] = useState(false);
	const [connectOpen, setConnectOpen] = useState(false);
	const canDeployOnClawdi = hydrated && IS_HOSTED && hostedAccess.canCreateCloudAgents;
	const checkingDeployAccess = hydrated && IS_HOSTED && hostedAccess.isLoading;
	const deployAccessError = hydrated && IS_HOSTED && hostedAccess.isError;

	function handleClick() {
		if (checkingDeployAccess) return;
		if (desktopBridge && !canDeployOnClawdi) {
			void desktopBridge.openConnectWizard().catch(() => setConnectOpen(true));
			return;
		}
		if (canDeployOnClawdi || deployAccessError) {
			setChooserOpen(true);
			return;
		}
		setConnectOpen(true);
	}

	function chooseConnect() {
		setChooserOpen(false);
		if (desktopBridge) {
			void desktopBridge.openConnectWizard().catch(() => setConnectOpen(true));
			return;
		}
		setConnectOpen(true);
	}

	function chooseDeploy() {
		if (!canDeployOnClawdi) return;
		setChooserOpen(false);
		onNavigate?.();
		void router.navigate({ href: "/deploy" });
	}

	const trigger = (
		<SidebarMenuButton
			tooltip={compact ? undefined : "New Agent"}
			aria-label="New Agent"
			onClick={handleClick}
			disabled={checkingDeployAccess}
			className={cn(
				"duration-200 ease-linear",
				compact &&
					"size-11 justify-center rounded-lg bg-sidebar-accent/70 p-0 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:bg-sidebar-accent active:text-sidebar-accent-foreground [&>svg]:size-5",
			)}
		>
			<CirclePlus />
			<span className={compact ? "sr-only" : undefined}>New Agent</span>
		</SidebarMenuButton>
	);

	return (
		<SidebarMenuItem className={className}>
			{compact && showTooltip ? (
				<Tooltip>
					<TooltipTrigger render={trigger} />
					<TooltipContent side="right" align="center">
						New Agent
					</TooltipContent>
				</Tooltip>
			) : (
				trigger
			)}

			<Dialog open={chooserOpen} onOpenChange={setChooserOpen}>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>New Agent</DialogTitle>
						<DialogDescription>
							{canDeployOnClawdi
								? "Deploy on Clawdi, or connect an Agent on your machine."
								: "Connect an Agent on your machine."}
						</DialogDescription>
					</DialogHeader>
					{deployAccessError ? (
						<ApiErrorPanel
							error={hostedAccess.error}
							onRetry={() => {
								void hostedAccess.refetch();
							}}
							title="Couldn't check Cloud deployment access"
						/>
					) : null}
					<div className={cn("grid gap-3", canDeployOnClawdi && "sm:grid-cols-2")}>
						{canDeployOnClawdi ? (
							<ChoiceCard
								icon={checkingDeployAccess ? <Loader2 className="animate-spin" /> : <Rocket />}
								title={checkingDeployAccess ? "Checking access" : "Deploy on Clawdi"}
								description="Clawdi runs and manages it — pick a framework and go live in minutes."
								onClick={chooseDeploy}
							/>
						) : null}
						<ChoiceCard
							icon={<TerminalSquare />}
							title="Connect an Agent on your machine"
							description={
								desktopBridge
									? "Find and connect Claude Code, Codex, Hermes, OpenClaw, Pi, or OpenCode."
									: "Claude Code, Codex, Hermes, OpenClaw, Pi, or OpenCode via the CLI."
							}
							onClick={chooseConnect}
						/>
					</div>
				</DialogContent>
			</Dialog>

			<AddAgentDialog open={connectOpen} onClose={() => setConnectOpen(false)} />
		</SidebarMenuItem>
	);
}

function ChoiceCard({
	icon,
	title,
	description,
	onClick,
}: {
	icon: React.ReactNode;
	title: string;
	description: string;
	onClick: () => void;
}) {
	return (
		<Button
			type="button"
			data-slot="new-agent-choice"
			onClick={onClick}
			variant="outline"
			className="h-auto min-h-32 w-full flex-col items-start justify-start gap-2 whitespace-normal p-4 text-left hover:border-primary/40 hover:bg-muted/50"
		>
			<IconChip size="sm" tint="bg-primary/10 text-primary" className="size-9 transition-colors">
				{icon}
			</IconChip>
			<span className="text-sm font-medium">{title}</span>
			<span className="text-xs text-muted-foreground">{description}</span>
		</Button>
	);
}
