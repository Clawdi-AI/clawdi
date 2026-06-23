"use client";

import { CirclePlus, Loader2, Rocket, TerminalSquare } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AddAgentDialog } from "@/components/dashboard/add-agent-dialog";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { IS_HOSTED } from "@/lib/hosted";
import { cn } from "@/lib/utils";
import { useV2Access } from "@/lib/v2-access";

export function NewAgentButton() {
	const router = useRouter();
	const v2Access = useV2Access();
	const [chooserOpen, setChooserOpen] = useState(false);
	const [connectOpen, setConnectOpen] = useState(false);
	const canDeployManagedAgent = IS_HOSTED && v2Access.canUseV2;
	const checkingDeployAccess = IS_HOSTED && v2Access.isLoading;

	function handleClick() {
		if (canDeployManagedAgent || checkingDeployAccess) {
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
		router.push("/deploy");
	}

	return (
		<>
			<SidebarMenuItem>
				<SidebarMenuButton
					tooltip="New agent"
					onClick={handleClick}
					className="bg-primary text-primary-foreground duration-200 ease-linear hover:bg-primary/90 hover:text-primary-foreground active:bg-primary/90 active:text-primary-foreground"
				>
					<CirclePlus />
					<span>New agent</span>
				</SidebarMenuButton>
			</SidebarMenuItem>

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
							icon={
								checkingDeployAccess ? (
									<Loader2 className="size-5 animate-spin" />
								) : (
									<Rocket className="size-5" />
								)
							}
							title={checkingDeployAccess ? "Checking deploy access" : "Deploy managed agent"}
							description="Clawdi-managed runtime — pick a framework and go live in minutes."
							onClick={chooseDeploy}
							disabled={!canDeployManagedAgent}
						/>
						<ChoiceCard
							icon={<TerminalSquare className="size-5" />}
							title="Connect your own agent"
							description="Claude Code, Codex, Hermes, or OpenClaw via the CLI."
							onClick={chooseConnect}
						/>
					</div>
				</DialogContent>
			</Dialog>

			<AddAgentDialog open={connectOpen} onClose={() => setConnectOpen(false)} />
		</>
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
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className={cn(
				"group flex flex-col gap-2 rounded-lg border bg-card p-4 text-left transition-colors",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
				disabled ? "cursor-not-allowed opacity-60" : "hover:border-primary/40 hover:bg-accent/40",
			)}
		>
			<span className="flex size-9 items-center justify-center rounded-md bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
				{icon}
			</span>
			<span className="text-sm font-medium">{title}</span>
			<span className="text-xs text-muted-foreground">{description}</span>
		</button>
	);
}
