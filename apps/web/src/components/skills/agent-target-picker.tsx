"use client";

/**
 * Agent selector for the /skills install card. Only renders for
 * accounts with ≥2 registered agents — single-agent users have
 * one obvious target and we suppress the picker entirely upstream.
 *
 * Dropdown rows use the canonical `<AgentLabel>` so the user reads
 * an agent the same way here as in the overview grid, the agent
 * detail hero, and the sessions table — same icon size, same
 * type-as-title hierarchy. The trigger stays single-line for the
 * fixed-height select chrome and renders a compact AgentIcon +
 * stringified label produced upstream by `targetAgentLabel`.
 */

import type { components } from "@clawdi/shared/api";
import { useMemo } from "react";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import { AgentLabel } from "@/components/dashboard/agent-label";
import { DaemonStatusBadge } from "@/components/dashboard/daemon-status";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { relativeTime } from "@/lib/utils";

type Env = components["schemas"]["EnvironmentResponse"];

interface AgentTargetPickerProps {
	envs: Env[];
	selectedScopeId: string | null;
	targetEnv: Env | undefined;
	targetAgentLabel: string;
	onChange: (scopeId: string) => void;
}

export function AgentTargetPicker({
	envs,
	selectedScopeId,
	targetEnv,
	targetAgentLabel,
	onChange,
}: AgentTargetPickerProps) {
	// Order envs by last_sync_at desc so the most-recently-active
	// agent is the first option a user scans. Envs that never
	// synced sink to the bottom.
	const ordered = useMemo(() => {
		return [...envs].sort((a, b) => {
			const aT = a.last_sync_at ? new Date(a.last_sync_at).getTime() : 0;
			const bT = b.last_sync_at ? new Date(b.last_sync_at).getTime() : 0;
			return bT - aT;
		});
	}, [envs]);

	return (
		<div className="flex flex-wrap items-center gap-3 text-sm">
			<span className="text-muted-foreground">Install on</span>
			<Select value={selectedScopeId ?? undefined} onValueChange={onChange}>
				<SelectTrigger className="h-9 min-w-[220px] gap-2">
					{targetEnv ? (
						<span className="flex items-center gap-2 truncate">
							<AgentIcon agent={targetEnv.agent_type} size="sm" />
							<span className="truncate">{targetAgentLabel}</span>
						</span>
					) : (
						<SelectValue placeholder={targetAgentLabel} />
					)}
				</SelectTrigger>
				{/* `position="popper"` + `align="start"` anchors the menu
				    directly under the trigger, left-edge flush. The
				    shadcn defaults (`item-aligned` + `align="center"`)
				    try to center the selected ROW on the trigger; with
				    a 2-line AgentLabel item that calculation drifts
				    far off-screen. */}
				<SelectContent position="popper" align="start">
					{ordered.map((env) =>
						env.default_scope_id ? (
							<SelectItem key={env.id} value={env.default_scope_id} className="py-2">
								<AgentLabel
									machineName={env.machine_name}
									type={env.agent_type}
									size="sm"
									primary="machine"
									meta={[
										env.last_sync_at ? `seen ${relativeTime(env.last_sync_at)}` : "never synced",
									]}
								/>
							</SelectItem>
						) : null,
					)}
				</SelectContent>
			</Select>
			{targetEnv ? <DaemonStatusBadge env={targetEnv} /> : null}
		</div>
	);
}
