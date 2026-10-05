"use client";

import {
	AGENT_AVATAR_MIME_TYPES,
	type components,
	MAX_AGENT_AVATAR_BYTES,
} from "@clawdi/shared/api";
import { agentDisconnectEligibility } from "@clawdi/shared/client";
import { agentSettingsPanelClasses } from "@clawdi/shared/ui";
import {
	agentDisplayName,
	agentSurfaceCopy,
	agentTypeLabel,
	errorMessage,
} from "@clawdi/shared/view";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { ExternalLink, RotateCcw, Save, Trash2, Unplug, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import { AgentSourceBadgeForEnvironment } from "@/components/dashboard/agent-label";
import { syncAgentNameDraft } from "@/components/dashboard/agent-settings-panel.logic";
import { SettingsSection } from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { UnsavedNavigationGuard } from "@/components/unsaved-navigation-guard";
import { useUnsavedNavigationState } from "@/components/unsaved-navigation-state";
import { agentOwnershipKindFromId, useAgentOwnership } from "@/lib/agent-ownership";
import { agentDetailQueryKey, agentDetailQueryOptions, agentsQueryKey } from "@/lib/agent-queries";
import { toastApiError, unwrap, useAgentAvatarUploader, useApi, useOpenApi } from "@/lib/api";
import { useProductAccess } from "@/lib/product-access";
import { shouldBlockQueryError } from "@/lib/query-state";
import { cn } from "@/lib/utils";

type Environment = components["schemas"]["AgentResponse"];
type EnvironmentUpdate = components["schemas"]["EnvironmentUpdate"];

function updateEnvironmentCaches(queryClient: QueryClient, environment: Environment) {
	queryClient.setQueryData(agentDetailQueryKey(environment.id), environment);
	queryClient.setQueryData<Environment[]>(agentsQueryKey, (current) =>
		current?.map((item) => (item.id === environment.id ? environment : item)),
	);
}

export function AgentSettingsPanel({
	environmentId,
	className,
}: {
	environmentId: string;
	className?: string;
}) {
	const api = useApi();
	const $api = useOpenApi();
	const router = useRouter();
	const queryClient = useQueryClient();
	const ownership = useAgentOwnership();
	const { legacyDashboardUrl: projectedLegacyDashboardUrl } = useProductAccess();
	const uploadAvatar = useAgentAvatarUploader();
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const lastServerNameRef = useRef<{ environmentId: string; name: string } | null>(null);
	const [draftName, setDraftName] = useState("");
	const {
		data: agent,
		isLoading,
		error,
	} = useQuery(agentDetailQueryOptions($api, queryClient, environmentId));

	const serverDraftName = agent ? (agent.display_name ? agent.display_name : "") : undefined;

	useEffect(() => {
		if (serverDraftName === undefined) return;
		const previous = lastServerNameRef.current;
		const previousServerName =
			previous?.environmentId === environmentId ? previous.name : undefined;
		lastServerNameRef.current = { environmentId, name: serverDraftName };
		setDraftName((currentDraft) =>
			syncAgentNameDraft(currentDraft, previousServerName, serverDraftName),
		);
	}, [environmentId, serverDraftName]);

	const updateIdentity = useMutation({
		mutationFn: async (body: EnvironmentUpdate) =>
			unwrap(
				await api.PATCH("/v1/agents/{agent_id}", {
					params: { path: { agent_id: environmentId } },
					body,
				}),
			),
		onSuccess: (data) => {
			updateEnvironmentCaches(queryClient, data);
			toast.success("Agent updated");
		},
		onError: toastApiError("Couldn't update agent"),
	});

	const uploadMutation = useMutation({
		mutationFn: async (file: File) => uploadAvatar(environmentId, file),
		onSuccess: (data) => {
			updateEnvironmentCaches(queryClient, data);
			toast.success("Avatar uploaded");
		},
		onError: toastApiError("Couldn't upload avatar"),
	});

	const clearAvatar = useMutation({
		mutationFn: async () =>
			unwrap(
				await api.DELETE("/v1/agents/{agent_id}/avatar", {
					params: { path: { agent_id: environmentId } },
				}),
			),
		onSuccess: (data) => {
			updateEnvironmentCaches(queryClient, data);
			toast.success("Avatar removed");
		},
		onError: toastApiError("Couldn't remove avatar"),
	});

	const disconnect = useMutation({
		mutationFn: async () =>
			unwrap(
				await api.DELETE("/v1/agents/{agent_id}", {
					params: { path: { agent_id: environmentId } },
				}),
			),
		onSuccess: () => {
			toast.success("Agent disconnected", {
				description: "Data is retained. Run clawdi setup on this installation to reconnect.",
			});
			void queryClient.invalidateQueries({ queryKey: ["get", "/v1/agents"] });
			void queryClient.invalidateQueries({ queryKey: ["get", "/v1/projects"] });
			void queryClient.invalidateQueries({ queryKey: ["get", "/v1/vault"] });
			void queryClient.invalidateQueries({
				predicate: (q) => {
					const key = q.queryKey[0];
					return key === "agents" || key === "sessions";
				},
			});
			void router.navigate({ href: "/agents" });
		},
		onError: toastApiError("Couldn't disconnect agent"),
	});

	const onUploadChange = (event: React.ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		event.target.value = "";
		if (!file) return;
		if (!AGENT_AVATAR_MIME_TYPES.some((type) => type === file.type)) {
			toast.error("Unsupported avatar file", {
				description: "Upload a PNG, JPEG, or WebP image.",
			});
			return;
		}
		if (file.size > MAX_AGENT_AVATAR_BYTES) {
			toast.error("Avatar image is too large", {
				description: "Upload an image up to 2 MB.",
			});
			return;
		}
		uploadMutation.mutate(file);
	};
	const normalizedDraftName = draftName.trim() || null;
	const currentName = agent?.display_name ? agent.display_name : null;
	const nameChanged = Boolean(agent) && normalizedDraftName !== currentName;
	const guardedBySurface = useUnsavedNavigationState({
		dirty: nameChanged,
		busy: updateIdentity.isPending,
	});

	if (isLoading) {
		return (
			<div className={className}>
				<Skeleton className={agentSettingsPanelClasses.hPxWFull} />
			</div>
		);
	}

	if (shouldBlockQueryError(error, agent) || !agent) {
		return (
			<div className={cn("flex flex-col gap-1 rounded-md border p-4", className)}>
				<div className={agentSettingsPanelClasses.textSmFontSemibold}>Settings unavailable</div>
				<p className={agentSettingsPanelClasses.textSmTextMuted}>
					{errorMessage(error ?? "Agent not found")}
				</p>
			</div>
		);
	}

	const hasCustomAvatar = Boolean(agent.avatar_url);
	const ownershipKind = agentOwnershipKindFromId(agent.id, ownership);
	// Disconnect archives the active Agent and Project, so it must wait for
	// RESOLVED ownership (`ownership !== null`). While the hosted sensor
	// is still resolving, a live hosted/legacy agent would otherwise briefly
	// classify as connected and expose a working Disconnect.
	const disconnectUnavailable = !agentDisconnectEligibility({
		platform: "web",
		agentId: agent.id,
		explicitIdentity: agent.explicit_identity,
		ownership,
	}).eligible;
	const isBusy =
		updateIdentity.isPending ||
		uploadMutation.isPending ||
		clearAvatar.isPending ||
		disconnect.isPending;
	const displayName = agentDisplayName(agent);
	const defaultDisplayName = agentDisplayName({ ...agent, display_name: null });
	const runtimeLabel = agentTypeLabel(agent.agent_type);
	const currentAvatarLabel = hasCustomAvatar ? "Custom upload" : `${runtimeLabel} default`;
	const legacyDashboardUrl = ownershipKind === "legacy" ? projectedLegacyDashboardUrl : null;

	return (
		<div className={cn("flex flex-col gap-8", className)}>
			{guardedBySurface ? null : (
				<UnsavedNavigationGuard
					dirty={nameChanged}
					busy={updateIdentity.isPending}
					description="Your agent name will return to the last value saved on the server."
				/>
			)}
			<input
				ref={fileInputRef}
				type="file"
				accept="image/png,image/jpeg,image/webp"
				aria-label="Upload agent avatar"
				className={agentSettingsPanelClasses.hidden}
				onChange={onUploadChange}
			/>
			<div className={agentSettingsPanelClasses.flexFlexColItems}>
				<AgentIcon agent={agent.agent_type} size="xl" avatarUrl={agent.avatar_url} />
				<div className={agentSettingsPanelClasses.flexMinWFlex}>
					<div className={agentSettingsPanelClasses.maxWFullTruncate}>{displayName}</div>
					<div className={agentSettingsPanelClasses.flexFlexWrapItems}>
						<span>{runtimeLabel}</span>
						<AgentSourceBadgeForEnvironment
							env={agent}
							ownershipKind={ownershipKind}
							compact
							showConnected
						/>
					</div>
				</div>
			</div>

			<SettingsSection
				title={agentSurfaceCopy.name}
				description={agentSurfaceCopy.useAShortNameThatDistinguishesThis}
			>
				<div className={agentSettingsPanelClasses.flexWFullFlex}>
					<div className={agentSettingsPanelClasses.flexFlexColGap}>
						<Label htmlFor="agent-display-name" className={agentSettingsPanelClasses.srOnly}>
							Agent name
						</Label>
						<Input
							id="agent-display-name"
							name="display_name"
							value={draftName}
							maxLength={120}
							placeholder={defaultDisplayName}
							autoComplete="off"
							onChange={(event) => setDraftName(event.target.value)}
						/>
						<Button
							type="button"
							size="sm"
							variant={nameChanged ? "default" : "outline"}
							className={agentSettingsPanelClasses.lgHLgMin}
							disabled={!nameChanged || updateIdentity.isPending}
							onClick={() => updateIdentity.mutate({ display_name: normalizedDraftName })}
						>
							{updateIdentity.isPending ? (
								<Spinner data-icon="inline-start" />
							) : (
								<Save data-icon="inline-start" />
							)}
							Save
						</Button>
					</div>
					<div className={agentSettingsPanelClasses.flexFlexColGap2}>
						<span className={agentSettingsPanelClasses.minWTruncate}>
							Default: {defaultDisplayName}
						</span>
						<Button
							type="button"
							size="sm"
							variant="ghost"
							className={agentSettingsPanelClasses.hWFitPx}
							disabled={!agent.display_name || updateIdentity.isPending}
							onClick={() => updateIdentity.mutate({ display_name: null })}
						>
							<RotateCcw data-icon="inline-start" />
							Use default name
						</Button>
					</div>
				</div>
			</SettingsSection>

			<SettingsSection
				title={agentSurfaceCopy.avatar}
				description={agentSurfaceCopy.shownInTheSidebarPickersAndAgent}
			>
				<div className={agentSettingsPanelClasses.flexFlexColGap3}>
					<div className={agentSettingsPanelClasses.flexMinWFlex2}>
						<AgentIcon agent={agent.agent_type} size="lg" avatarUrl={agent.avatar_url} />
						<div className={agentSettingsPanelClasses.minW}>
							<div className={agentSettingsPanelClasses.truncateTextSmFont}>
								{currentAvatarLabel}
							</div>
							<div className={agentSettingsPanelClasses.textXsTextMuted}>
								{agentSurfaceCopy.imageUpTo2Mb}
							</div>
						</div>
					</div>
					<div className={agentSettingsPanelClasses.flexShrinkFlexWrap}>
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={isBusy}
							onClick={() => fileInputRef.current?.click()}
						>
							{uploadMutation.isPending ? (
								<Spinner data-icon="inline-start" />
							) : (
								<Upload data-icon="inline-start" />
							)}
							Upload image
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							disabled={isBusy || !hasCustomAvatar}
							onClick={() => clearAvatar.mutate()}
							className={agentSettingsPanelClasses.textMutedForeground}
						>
							{clearAvatar.isPending ? (
								<Spinner data-icon="inline-start" />
							) : (
								<Trash2 data-icon="inline-start" />
							)}
							Remove
						</Button>
					</div>
				</div>
			</SettingsSection>

			{legacyDashboardUrl ? (
				<SettingsSection
					title="Legacy dashboard"
					description="Manage this Legacy hosted agent in the legacy dashboard."
				>
					<div className={agentSettingsPanelClasses.flexFlexColGap4}>
						<p className={agentSettingsPanelClasses.maxWMdText}>
							This agent uses the legacy management surface for runtime actions.
						</p>
						<Button
							variant="outline"
							size="sm"
							render={
								<a
									href={legacyDashboardUrl}
									target="_blank"
									rel="noopener noreferrer"
									aria-label="Open legacy dashboard"
								/>
							}
							nativeButton={false}
						>
							<ExternalLink data-icon="inline-start" />
							Open legacy dashboard
						</Button>
					</div>
				</SettingsSection>
			) : null}

			{!disconnectUnavailable ? (
				<SettingsSection
					title={agentSurfaceCopy.disconnect}
					description={agentSurfaceCopy.stopThisInstallationWhileKeepingItsClawdi}
					variant="destructive"
				>
					<div className={agentSettingsPanelClasses.flexFlexColGap4}>
						<p className={agentSettingsPanelClasses.maxWMdText}>
							Sync stops and retained Sessions, Skills, files, and Projects stay in your account.
						</p>
						<ConfirmAction
							title="Disconnect this agent?"
							description={
								<p>
									Disconnect stops this installation and removes it from active views. Run{" "}
									<code>clawdi setup</code> on it to reconnect with the same retained data.
								</p>
							}
							confirmLabel="Disconnect agent"
							destructive
							onConfirm={() => disconnect.mutateAsync()}
						>
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={disconnect.isPending}
								className={agentSettingsPanelClasses.borderDestructiveTextDestructive}
							>
								{disconnect.isPending ? (
									<Spinner data-icon="inline-start" />
								) : (
									<Unplug data-icon="inline-start" />
								)}
								Disconnect agent
							</Button>
						</ConfirmAction>
					</div>
				</SettingsSection>
			) : null}
		</div>
	);
}
