"use client";

import { Bot, ExternalLink, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import { BillingError } from "@/hosted/billing/components/state-views";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import { useHostedDeployments } from "@/hosted/billing/hooks";

type StatusTone = "success" | "warning" | "destructive" | "info" | "neutral";

function statusTone(status: string): StatusTone {
	if (status === "running" || status === "ready") return "success";
	if (status === "failed" || status === "error") return "destructive";
	if (status === "stopped") return "neutral";
	return "warning";
}

function statusLabel(status: string): string {
	if (status === "running" || status === "ready") return "Running";
	if (status === "provisioning") return "Provisioning";
	if (status === "starting") return "Starting";
	if (status === "pending") return "Pending";
	if (status === "failed" || status === "error") return "Failed";
	if (status === "stopped") return "Stopped";
	return status;
}

function deploymentLabel(d: HostedDeployment): string {
	return d.name.replace(/^(openclaw|hermes)-/i, "") || d.name;
}

/** "OpenClaw + Hermes" — enabled runtime summary for a deployment. */
function metaLine(d: HostedDeployment): string | null {
	const info = d.config_info;
	if (!info) return null;
	const engines = [info.enable_openclaw && "OpenClaw", info.enable_hermes && "Hermes"]
		.filter(Boolean)
		.join(" + ");
	return engines || null;
}

/**
 * Open-OpenClaw / Open-Hermes controls for hosted deployments. Each button
 * uses the backend's pre-authed `*_ui_url` (already carries `?t=<token>`); we
 * never build the token URL ourselves, and disable a button when its field is
 * missing (e.g. while the agent is still provisioning).
 *
 * Renders null when the user has no hosted deployments, so it can sit on the
 * overview without adding noise for connected-agent-only users.
 */
export function HostedAgentControls() {
	const deployments = useHostedDeployments();
	const items = deployments.data ?? [];
	if (deployments.isLoading) return null;

	if (deployments.error) {
		return (
			<Card data-hosted="true">
				<CardHeader>
					<CardTitle className="text-base">Clawdi Cloud agents</CardTitle>
					<CardDescription>Open a live cloud agent.</CardDescription>
				</CardHeader>
				<CardContent>
					<BillingError
						error={deployments.error}
						onRetry={() => deployments.refetch()}
						title="Couldn’t load Clawdi Cloud agents"
					/>
				</CardContent>
			</Card>
		);
	}

	if (items.length === 0) return null;

	return (
		<Card data-hosted="true">
			<CardHeader>
				<CardTitle className="text-base">Clawdi Cloud agents</CardTitle>
				<CardDescription>Open a live cloud agent.</CardDescription>
			</CardHeader>
			<CardContent className="space-y-3">
				{items.map((d) => {
					const openclaw = d.openclaw_ui_url;
					const hermes = d.hermes_ui_url;
					const meta = metaLine(d);
					const provisioning = !openclaw && !hermes;
					return (
						<div key={d.id} className="flex flex-col gap-2.5 rounded-lg border p-3">
							<div className="flex items-center justify-between gap-2">
								<span className="min-w-0 truncate text-sm font-medium">{deploymentLabel(d)}</span>
								<StatusBadge status={statusTone(d.status)} withDot>
									{statusLabel(d.status)}
								</StatusBadge>
							</div>
							{meta ? <p className="text-xs text-muted-foreground">{meta}</p> : null}
							<div className="flex flex-wrap gap-2">
								{openclaw ? (
									<Button asChild size="sm" variant="outline">
										<a href={openclaw} target="_blank" rel="noopener noreferrer">
											<Bot /> Open OpenClaw <ExternalLink className="size-3.5" />
										</a>
									</Button>
								) : (
									<Button
										size="sm"
										variant="outline"
										disabled
										title={
											provisioning ? "Available once the agent finishes provisioning" : undefined
										}
									>
										<Bot /> OpenClaw
									</Button>
								)}
								{hermes ? (
									<Button asChild size="sm" variant="outline">
										<a href={hermes} target="_blank" rel="noopener noreferrer">
											<Sparkles /> Open Hermes <ExternalLink className="size-3.5" />
										</a>
									</Button>
								) : (
									<Button
										size="sm"
										variant="outline"
										disabled
										title={
											provisioning ? "Available once the agent finishes provisioning" : undefined
										}
									>
										<Sparkles /> Hermes
									</Button>
								)}
							</div>
						</div>
					);
				})}
			</CardContent>
		</Card>
	);
}
