"use client";

import { useRouter } from "@tanstack/react-router";
import { CirclePlus, Loader2, Rocket, TerminalSquare } from "lucide-react";
import { useEffect, useState } from "react";
import { AddAgentDialog } from "@/components/dashboard/add-agent-dialog";
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
import { useHostedProductAccess } from "@/lib/hosted-product-access";
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
	const hostedAccess = useHostedProductAccess();
	const [mounted, setMounted] = useState(false);
	const [chooserOpen, setChooserOpen] = useState(false);
	const [connectOpen, setConnectOpen] = useState(false);
	useEffect(() => {
		setMounted(true);
	}, []);
	const canDeployManagedAgent = mounted && IS_HOSTED && hostedAccess.canUseCloudAgents;
	const checkingDeployAccess = mounted && IS_HOSTED && hostedAccess.isLoading;

	function handleClick() {
		if (checkingDeployAccess) return;
		if (canDeployManagedAgent) {
			setChooserOpen(true);
			return;
		}
		setConnectOpen(true);
	}

	function chooseConnect() {
		setChooserOpen(false);
		setConnectOpen(true);
	}

	function chooseDeploy() {
		if (!canDeployManagedAgent) return;
		setChooserOpen(false);
		onNavigate?.();
		void router.navigate({ href: "/deploy" });
	}

	const trigger = (
		<SidebarMenuButton
			tooltip={compact ? undefined : "New agent"}
			aria-label="New agent"
			onClick={handleClick}
			disabled={checkingDeployAccess}
			className={cn(
				"duration-200 ease-linear",
				compact &&
					"size-11 justify-center rounded-lg bg-sidebar-accent/70 p-0 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:bg-sidebar-accent active:text-sidebar-accent-foreground [&>svg]:size-4.5",
			)}
		>
			<CirclePlus />
			<span className={compact ? "sr-only" : undefined}>New agent</span>
		</SidebarMenuButton>
	);

	return (
		<SidebarMenuItem className={className}>
			{compact && showTooltip ? (
				<Tooltip>
					<TooltipTrigger asChild>{trigger}</TooltipTrigger>
					<TooltipContent side="right" align="center">
						New agent
					</TooltipContent>
				</Tooltip>
			) : (
				trigger
			)}

			<Dialog open={chooserOpen} onOpenChange={setChooserOpen}>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>New agent</DialogTitle>
						<DialogDescription>
							Deploy a managed agent on Clawdi, or connect an agent you already run.
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-3 sm:grid-cols-2">
						<ChoiceCard
							icon={checkingDeployAccess ? <Loader2 className="animate-spin" /> : <Rocket />}
							title={checkingDeployAccess ? "Checking deploy access" : "Deploy managed agent"}
							description="Clawdi-managed runtime — pick a framework and go live in minutes."
							onClick={chooseDeploy}
							disabled={!canDeployManagedAgent}
						/>
						<ChoiceCard
							icon={<TerminalSquare />}
							title="Connect your own agent"
							description="Claude Code, Codex, Hermes, or OpenClaw via the CLI."
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
	disabled = false,
}: {
	icon: React.ReactNode;
	title: string;
	description: string;
	onClick: () => void;
	disabled?: boolean;
}) {
	return (
		<Button
			type="button"
			data-slot="new-agent-choice"
			onClick={onClick}
			disabled={disabled}
			variant="outline"
			className={cn(
				"h-auto min-h-32 w-full flex-col items-start justify-start gap-2 whitespace-normal p-4 text-left",
				!disabled && "hover:border-primary/40 hover:bg-muted/50",
			)}
		>
			<span className="flex size-9 items-center justify-center rounded-md bg-primary/10 text-primary transition-colors">
				{icon}
			</span>
			<span className="text-sm font-medium">{title}</span>
			<span className="text-xs text-muted-foreground">{description}</span>
		</Button>
	);
}
