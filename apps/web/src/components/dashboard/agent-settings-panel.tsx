"use client";

import type { components } from "@clawdi/shared/api";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { ExternalLink, RotateCcw, Save, Trash2, Unplug, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import {
	AgentSourceBadgeForEnvironment,
	agentDisplayName,
	agentTypeLabel,
} from "@/components/dashboard/agent-label";
import { SettingsSection } from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
	agentDisconnectUnavailable,
	agentOwnershipKindFromId,
	useAgentOwnership,
} from "@/lib/agent-ownership";
import { unwrap, useAgentAvatarUploader, useApi } from "@/lib/api";
import { legacyHostedDashboardUrl } from "@/lib/legacy-hosted-dashboard";
import { cn, errorMessage } from "@/lib/utils";

type Environment = components["schemas"]["AgentResponse"];
type EnvironmentUpdate = components["schemas"]["EnvironmentUpdate"];

const MAX_AGENT_AVATAR_BYTES = 2 * 1024 * 1024;
const AGENT_AVATAR_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function updateEnvironmentCaches(queryClient: QueryClient, environment: Environment) {
	queryClient.setQueryData(["agents", environment.id], environment);
	queryClient.setQueryData<Environment[]>(["agents"], (current) =>
		current?.map((item) => (item.id === environment.id ? environment : item)),
	);
}

export function AgentSettingsPanel({
	environmentId,
	className,
	formatName,
}: {
	environmentId: string;
	className?: string;
	formatName?: (name: string) => string;
}) {
	const api = useApi();
	const router = useRouter();
	const queryClient = useQueryClient();
	const ownership = useAgentOwnership();
	const uploadAvatar = useAgentAvatarUploader();
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const [draftName, setDraftName] = useState("");
	const {
		data: agent,
		isLoading,
		error,
	} = useQuery({
		queryKey: ["agents", environmentId],
		queryFn: async () =>
			unwrap(
				await api.GET("/v1/agents/{agent_id}", {
					params: { path: { agent_id: environmentId } },
				}),
			),
	});

	useEffect(() => {
		if (!agent) return;
		setDraftName(
			agent.display_name ? (formatName?.(agent.display_name) ?? agent.display_name) : "",
		);
	}, [agent, formatName]);

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
		onError: (e) => toast.error("Couldn't update agent", { description: errorMessage(e) }),
	});

	const uploadMutation = useMutation({
		mutationFn: async (file: File) => uploadAvatar(environmentId, file),
		onSuccess: (data) => {
			updateEnvironmentCaches(queryClient, data);
			toast.success("Avatar uploaded");
		},
		onError: (e) => toast.error("Couldn't upload avatar", { description: errorMessage(e) }),
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
		onError: (e) => toast.error("Couldn't remove avatar", { description: errorMessage(e) }),
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
				description: "Sessions and skills stay in your account.",
			});
			queryClient.invalidateQueries({
				predicate: (q) => {
					const key = q.queryKey[0];
					return key === "agents" || key === "sessions";
				},
			});
			void router.navigate({ href: "/" });
		},
		onError: (e) => toast.error("Couldn't disconnect agent", { description: errorMessage(e) }),
	});

	const onUploadChange = (event: React.ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		event.target.value = "";
		if (!file) return;
		if (!AGENT_AVATAR_MIME_TYPES.has(file.type)) {
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

	if (isLoading) {
		return (
			<div className={className}>
				<Skeleton className="h-[420px] w-full rounded-lg" />
			</div>
		);
	}

	if (error || !agent) {
		return (
			<div className={cn("flex flex-col gap-1 rounded-md border p-4", className)}>
				<div className="text-sm font-semibold">Settings unavailable</div>
				<p className="text-sm text-muted-foreground">{errorMessage(error ?? "Agent not found")}</p>
			</div>
		);
	}

	const normalizedDraftName = draftName.trim() || null;
	const currentCustomName = agent.display_name
		? (formatName?.(agent.display_name) ?? agent.display_name)
		: null;
	const nameChanged = normalizedDraftName !== currentCustomName;
	const hasCustomAvatar = Boolean(agent.avatar_url);
	const ownershipKind = agentOwnershipKindFromId(agent.id, ownership);
	// Disconnect deregisters the environment — destructive, so it must wait
	// for RESOLVED ownership (`ownership !== null`). While the hosted sensor
	// is still resolving, a live hosted/legacy agent would otherwise briefly
	// classify as connected and expose a working Disconnect.
	const disconnectUnavailable = agentDisconnectUnavailable({
		envId: agent.id,
		explicitIdentity: agent.explicit_identity,
		ownership,
	});
	const isBusy =
		updateIdentity.isPending ||
		uploadMutation.isPending ||
		clearAvatar.isPending ||
		disconnect.isPending;
	const rawDisplayName = agentDisplayName(agent);
	const rawDefaultDisplayName = agentDisplayName({ ...agent, display_name: null });
	const displayName = formatName?.(rawDisplayName) ?? rawDisplayName;
	const defaultDisplayName = formatName?.(rawDefaultDisplayName) ?? rawDefaultDisplayName;
	const runtimeLabel = agentTypeLabel(agent.agent_type);
	const currentAvatarLabel = hasCustomAvatar ? "Custom upload" : `${runtimeLabel} default`;
	const legacyDashboardUrl = ownershipKind === "legacy" ? legacyHostedDashboardUrl() : null;

	return (
		<div className={cn("flex flex-col gap-9", className)}>
			<input
				ref={fileInputRef}
				type="file"
				accept="image/png,image/jpeg,image/webp"
				aria-label="Upload agent avatar"
				className="hidden"
				onChange={onUploadChange}
			/>
			<div className="flex flex-col items-center gap-5 text-center sm:flex-row sm:text-left">
				<AgentIcon agent={agent.agent_type} size="xl" avatarUrl={agent.avatar_url} />
				<div className="flex min-w-0 flex-col gap-1">
					<div className="max-w-full truncate text-lg font-semibold leading-7">{displayName}</div>
					<div className="flex flex-wrap items-center justify-center gap-2 text-sm text-muted-foreground sm:justify-start">
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
				title="Display name"
				description="Use a short name that distinguishes this agent from others."
			>
				<div className="flex max-w-2xl flex-col gap-3">
					<div className="flex flex-col gap-2 lg:flex-row">
						<Label htmlFor="agent-display-name" className="sr-only">
							Display name
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
							className="lg:h-9 lg:min-w-20"
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
					<div className="flex flex-col gap-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
						<span className="min-w-0 truncate">Default: {defaultDisplayName}</span>
						<Button
							type="button"
							size="sm"
							variant="ghost"
							className="h-7 w-fit px-2 text-xs text-muted-foreground"
							disabled={!agent.display_name || updateIdentity.isPending}
							onClick={() => updateIdentity.mutate({ display_name: null })}
						>
							<RotateCcw data-icon="inline-start" />
							Use default name
						</Button>
					</div>
				</div>
			</SettingsSection>

			<SettingsSection title="Avatar" description="Shown in the sidebar, pickers, and agent lists.">
				<div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
					<div className="flex min-w-0 flex-1 items-center gap-3">
						<AgentIcon agent={agent.agent_type} size="lg" avatarUrl={agent.avatar_url} />
						<div className="min-w-0">
							<div className="truncate text-sm font-medium">{currentAvatarLabel}</div>
							<div className="text-xs text-muted-foreground">Image up to 2 MB.</div>
						</div>
					</div>
					<div className="flex shrink-0 flex-wrap gap-2 lg:justify-end">
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
							className="text-muted-foreground"
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
					<div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
						<p className="max-w-md text-sm text-muted-foreground">
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
					title="Disconnect"
					description="Remove this connected agent from your dashboard."
					variant="destructive"
				>
					<div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
						<p className="max-w-md text-sm text-muted-foreground">
							The agent stops syncing here. Existing sessions, skills, and Projects stay in your
							account.
						</p>
						<ConfirmAction
							title="Disconnect this agent?"
							description={
								<>
									<p>Sessions and skills stay in your account.</p>
									<p>
										This agent will stop syncing and sessions will no longer be tagged with it.
										Reconnect from that agent to resume.
									</p>
								</>
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
								className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
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
