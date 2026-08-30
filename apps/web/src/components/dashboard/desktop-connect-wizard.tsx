"use client";

import type {
	ClawdiDesktopBridge,
	DesktopAgentType,
	DesktopBootstrapState,
	DesktopDetectedAgent,
} from "@clawdi/shared/desktop";
import { Link } from "@tanstack/react-router";
import {
	ArrowRight,
	Check,
	CircleCheckBig,
	Loader2,
	RefreshCw,
	ShieldCheck,
	TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { errorMessage } from "@/lib/utils";

type WizardStage = "loading" | "authenticate" | "select" | "connecting" | "complete" | "error";

export function DesktopConnectWizard({ bridge }: { bridge: ClawdiDesktopBridge }) {
	const [stage, setStage] = useState<WizardStage>("loading");
	const [bootstrap, setBootstrap] = useState<DesktopBootstrapState | null>(null);
	const [agents, setAgents] = useState<DesktopDetectedAgent[]>([]);
	const [selected, setSelected] = useState<Set<DesktopAgentType>>(new Set());
	const [failure, setFailure] = useState<string | null>(null);

	const showFailure = useCallback((error: unknown) => {
		setFailure(errorMessage(error));
		setStage("error");
	}, []);

	const loadAgents = useCallback(async () => {
		setStage("loading");
		try {
			const detected = await bridge.detectAgents();
			setAgents(detected);
			setSelected(
				new Set(
					detected
						.filter((agent) => agent.detected && !agent.registered)
						.map((agent) => agent.type),
				),
			);
			setStage("select");
		} catch (error) {
			showFailure(error);
		}
	}, [bridge, showFailure]);

	const load = useCallback(async () => {
		setStage("loading");
		setFailure(null);
		try {
			const state = await bridge.getBootstrapState();
			setBootstrap(state);
			if (!state.auth.authenticated) {
				setStage("authenticate");
				return;
			}
			await loadAgents();
		} catch (error) {
			showFailure(error);
		}
	}, [bridge, loadAgents, showFailure]);

	useEffect(() => {
		void load();
	}, [load]);

	async function authenticate() {
		setStage("loading");
		setFailure(null);
		try {
			const state = await bridge.authenticate();
			setBootstrap(state);
			await loadAgents();
		} catch (error) {
			showFailure(error);
		}
	}

	async function connect() {
		const requested =
			selected.size > 0
				? [...selected]
				: agents.filter((agent) => agent.registered).map((agent) => agent.type);
		if (requested.length === 0) return;
		setStage("connecting");
		setFailure(null);
		try {
			await bridge.connectAgents(requested);
			setStage("complete");
		} catch (error) {
			showFailure(error);
		}
	}

	if (stage === "loading") {
		return <CenteredStatus icon={<Loader2 className="animate-spin" />} title="Checking this Mac" />;
	}

	if (stage === "authenticate") {
		return (
			<div className="space-y-5">
				<div className="flex gap-3 rounded-lg border bg-muted/20 p-4">
					<span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
						<ShieldCheck className="size-5" />
					</span>
					<div className="min-w-0">
						<p className="text-sm font-medium">Sign in to Clawdi</p>
						<p className="mt-1 text-xs leading-relaxed text-muted-foreground">
							Your browser will open for secure authorization, then return here automatically.
						</p>
					</div>
				</div>
				<div className="flex justify-end">
					<Button onClick={() => void authenticate()}>
						Continue in browser <ArrowRight data-icon="inline-end" />
					</Button>
				</div>
			</div>
		);
	}

	if (stage === "connecting") {
		return (
			<CenteredStatus
				icon={<Loader2 className="animate-spin" />}
				title="Connecting your Agents"
				description="Clawdi is registering them and starting background sync."
			/>
		);
	}

	if (stage === "complete") {
		return (
			<div className="space-y-5">
				<CenteredStatus
					icon={<CircleCheckBig />}
					title="Agents connected"
					description="Background sync will keep running when this window is closed."
					iconClassName="bg-success-muted text-success"
				/>
				<div className="flex justify-end">
					<Button render={<Link to="/agents" />} nativeButton={false}>
						View Agents <ArrowRight data-icon="inline-end" />
					</Button>
				</div>
			</div>
		);
	}

	if (stage === "error") {
		return (
			<div className="space-y-4">
				<Alert variant="destructive">
					<TriangleAlert />
					<AlertTitle>Couldn't finish setup</AlertTitle>
					<AlertDescription>{failure ?? "Try again."}</AlertDescription>
				</Alert>
				<div className="flex justify-end">
					<Button variant="outline" onClick={() => void load()}>
						<RefreshCw data-icon="inline-start" /> Retry
					</Button>
				</div>
			</div>
		);
	}

	return (
		<AgentSelection
			agents={agents}
			selected={selected}
			account={bootstrap?.auth.user?.email}
			daemonReady={bootstrap?.daemon.running === true}
			onToggle={(type, checked) => {
				setSelected((current) => {
					const next = new Set(current);
					if (checked) next.add(type);
					else next.delete(type);
					return next;
				});
			}}
			onRefresh={() => void loadAgents()}
			onConnect={() => void connect()}
		/>
	);
}

function AgentSelection({
	agents,
	selected,
	account,
	daemonReady,
	onToggle,
	onRefresh,
	onConnect,
}: {
	agents: DesktopDetectedAgent[];
	selected: ReadonlySet<DesktopAgentType>;
	account?: string;
	daemonReady: boolean;
	onToggle(type: DesktopAgentType, checked: boolean): void;
	onRefresh(): void;
	onConnect(): void;
}) {
	const found = useMemo(
		() => agents.filter((agent) => agent.detected || agent.registered).length,
		[agents],
	);
	const canRepairDaemon = !daemonReady && agents.some((agent) => agent.registered);
	return (
		<div className="space-y-4">
			<div className="flex items-start justify-between gap-3">
				<div>
					<p className="text-sm font-medium">
						{found > 0 ? `Found ${found} Agent${found === 1 ? "" : "s"}` : "No Agents found"}
					</p>
					<p className="mt-1 text-xs text-muted-foreground">
						{account ? `Connecting to ${account}` : "Select the Agents to connect."}
					</p>
				</div>
				<Button variant="ghost" size="icon-sm" onClick={onRefresh} aria-label="Scan again">
					<RefreshCw />
				</Button>
			</div>

			<div className="divide-y overflow-hidden rounded-lg border">
				{agents.map((agent) => {
					const available = agent.detected && !agent.registered;
					return (
						<div
							key={agent.type}
							className="flex min-h-14 items-center gap-3 px-3 py-2.5 has-[:disabled]:bg-muted/20"
						>
							<Checkbox
								checked={agent.registered || selected.has(agent.type)}
								disabled={!available}
								onCheckedChange={(checked) => onToggle(agent.type, checked === true)}
								aria-label={`Connect ${agent.displayName}`}
							/>
							<AgentIcon agent={agent.type} size="lg" />
							<div className="min-w-0 flex-1">
								<p className="truncate text-sm font-medium">{agent.displayName}</p>
								<p className="truncate text-xs text-muted-foreground">
									{agent.registered
										? "Already connected"
										: agent.detected
											? (agent.version ?? "Local data found")
											: agent.inspection === "failed"
												? "Couldn't inspect"
												: "Not installed"}
								</p>
							</div>
							{agent.registered ? <Check className="size-4 text-success" /> : null}
						</div>
					);
				})}
			</div>

			<div className="flex justify-end">
				<Button disabled={selected.size === 0 && !canRepairDaemon} onClick={onConnect}>
					{selected.size > 0
						? `Connect ${selected.size} Agent${selected.size === 1 ? "" : "s"}`
						: canRepairDaemon
							? "Start background sync"
							: "Agents connected"}
					<ArrowRight data-icon="inline-end" />
				</Button>
			</div>
		</div>
	);
}

function CenteredStatus({
	icon,
	title,
	description,
	iconClassName = "bg-primary/10 text-primary",
}: {
	icon: React.ReactNode;
	title: string;
	description?: string;
	iconClassName?: string;
}) {
	return (
		<div className="flex min-h-48 flex-col items-center justify-center px-6 text-center">
			<span
				className={`mb-3 flex size-10 items-center justify-center rounded-md [&>svg]:size-5 ${iconClassName}`}
			>
				{icon}
			</span>
			<p className="text-sm font-medium">{title}</p>
			{description ? (
				<p className="mt-1 max-w-sm text-xs text-muted-foreground">{description}</p>
			) : null}
		</div>
	);
}
