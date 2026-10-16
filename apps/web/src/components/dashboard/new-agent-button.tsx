"use client";

import { newAgentChooserClasses } from "@clawdi/shared/ui";
import { newAgentChooserCopy } from "@clawdi/shared/view";
import { useRouter } from "@tanstack/react-router";
import { CirclePlus, Loader2, Rocket, TerminalSquare } from "lucide-react";
import { useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { useConnectAgent } from "@/components/dashboard/use-connect-agent";
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
	const hostedAccess = useProductAccess();
	const hydrated = useHydrated();
	const [chooserOpen, setChooserOpen] = useState(false);
	const { connect, dialog: connectDialog } = useConnectAgent();
	const canDeployOnClawdi = hydrated && IS_HOSTED && hostedAccess.canCreateCloudAgents;
	const checkingDeployAccess = hydrated && IS_HOSTED && hostedAccess.isLoading;
	const deployAccessError = hydrated && IS_HOSTED && hostedAccess.isError;

	function handleClick() {
		if (checkingDeployAccess) return;
		if (canDeployOnClawdi || deployAccessError) {
			setChooserOpen(true);
			return;
		}
		connect();
	}

	function chooseConnect() {
		setChooserOpen(false);
		connect();
	}

	function chooseDeploy() {
		if (!canDeployOnClawdi) return;
		setChooserOpen(false);
		onNavigate?.();
		void router.navigate({ href: "/deploy" });
	}

	const trigger = (
		<SidebarMenuButton
			tooltip={compact ? undefined : newAgentChooserCopy.title}
			aria-label={newAgentChooserCopy.title}
			onClick={handleClick}
			disabled={checkingDeployAccess}
			className={cn(
				"duration-200 ease-linear",
				compact &&
					"size-11 justify-center rounded-lg bg-sidebar-accent/70 p-0 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:bg-sidebar-accent active:text-sidebar-accent-foreground [&>svg]:size-5",
			)}
		>
			<CirclePlus />
			<span className={compact ? "sr-only" : undefined}>{newAgentChooserCopy.title}</span>
		</SidebarMenuButton>
	);

	return (
		<SidebarMenuItem className={className}>
			{compact && showTooltip ? (
				<Tooltip>
					<TooltipTrigger render={trigger} />
					<TooltipContent side="right" align="center">
						{newAgentChooserCopy.title}
					</TooltipContent>
				</Tooltip>
			) : (
				trigger
			)}

			<Dialog open={chooserOpen} onOpenChange={setChooserOpen}>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>{newAgentChooserCopy.title}</DialogTitle>
						<DialogDescription>
							{newAgentChooserCopy.description(canDeployOnClawdi)}
						</DialogDescription>
					</DialogHeader>
					{deployAccessError ? (
						<ApiErrorPanel
							error={hostedAccess.error}
							onRetry={() => {
								void hostedAccess.refetch();
							}}
							title={newAgentChooserCopy.accessError}
						/>
					) : null}
					<div
						className={cn(
							newAgentChooserClasses.choices,
							canDeployOnClawdi && newAgentChooserClasses.choicesWithDeploy,
						)}
					>
						{canDeployOnClawdi ? (
							<ChoiceCard
								icon={checkingDeployAccess ? <Loader2 className="animate-spin" /> : <Rocket />}
								title={
									checkingDeployAccess
										? newAgentChooserCopy.checkingAccess
										: newAgentChooserCopy.deployTitle
								}
								description={newAgentChooserCopy.deployDescription}
								onClick={chooseDeploy}
							/>
						) : null}
						<ChoiceCard
							icon={<TerminalSquare />}
							title={newAgentChooserCopy.connectTitle}
							description={newAgentChooserCopy.connectDescription}
							onClick={chooseConnect}
						/>
					</div>
				</DialogContent>
			</Dialog>

			{connectDialog}
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
			className={newAgentChooserClasses.choice}
		>
			<IconChip
				size="sm"
				tint={newAgentChooserClasses.chipTint}
				className={newAgentChooserClasses.chip}
			>
				{icon}
			</IconChip>
			<span className={newAgentChooserClasses.title}>{title}</span>
			<span className={newAgentChooserClasses.description}>{description}</span>
		</Button>
	);
}
