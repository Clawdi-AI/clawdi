"use client";

import type { components } from "@clawdi/shared/api";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Save, Trash2, Unplug, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import {
	AgentSourceBadgeForEnvironment,
	agentDisplayName,
	agentIdentitySeed,
	agentTypeLabel,
	isHostedAgentEnvironment,
} from "@/components/dashboard/agent-label";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { unwrap, useAgentAvatarUploader, useApi } from "@/lib/api";
import { cn, errorMessage } from "@/lib/utils";

type Environment = components["schemas"]["EnvironmentResponse"];
type EnvironmentUpdate = components["schemas"]["EnvironmentUpdate"];

const MAX_AGENT_AVATAR_BYTES = 2 * 1024 * 1024;
const AGENT_AVATAR_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function updateEnvironmentCaches(queryClient: QueryClient, environment: Environment) {
	queryClient.setQueryData(["agent", environment.id], environment);
	queryClient.setQueryData<Environment[]>(["environments"], (current) =>
		current?.map((item) => (item.id === environment.id ? environment : item)),
	);
}

function SettingsSection({
	title,
	description,
	children,
	className,
}: {
	title: string;
	description?: string;
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<section
			className={cn(
				"grid gap-4 px-6 py-5 md:grid-cols-[170px_minmax(0,1fr)] md:items-start",
				className,
			)}
		>
			<div className="space-y-1">
				<div className="text-sm font-medium">{title}</div>
				{description ? (
					<p className="max-w-52 text-xs leading-5 text-muted-foreground">{description}</p>
				) : null}
			</div>
			<div className="min-w-0">{children}</div>
		</section>
	);
}

export function AgentSettingsPanel({ environmentId }: { environmentId: string }) {
	const api = useApi();
	const router = useRouter();
	const queryClient = useQueryClient();
	const uploadAvatar = useAgentAvatarUploader();
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const [draftName, setDraftName] = useState("");
	const {
		data: agent,
		isLoading,
		error,
	} = useQuery({
		queryKey: ["agent", environmentId],
		queryFn: async () =>
			unwrap(
				await api.GET("/api/environments/{environment_id}", {
					params: { path: { environment_id: environmentId } },
				}),
			),
	});

	useEffect(() => {
		if (!agent) return;
		setDraftName(agent.display_name ?? "");
	}, [agent]);

	const updateIdentity = useMutation({
		mutationFn: async (body: EnvironmentUpdate) =>
			unwrap(
				await api.PATCH("/api/environments/{environment_id}", {
					params: { path: { environment_id: environmentId } },
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
				await api.DELETE("/api/environments/{environment_id}/avatar", {
					params: { path: { environment_id: environmentId } },
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
				await api.DELETE("/api/environments/{environment_id}", {
					params: { path: { environment_id: environmentId } },
				}),
			),
		onSuccess: () => {
			toast.success("Agent disconnected", {
				description: "Sessions and skills stay in your account.",
			});
			queryClient.invalidateQueries({
				predicate: (q) => {
					const key = q.queryKey[0];
					return key === "environments" || key === "sessions" || key === "agent";
				},
			});
			router.push("/");
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
			<div className="w-full">
				<Skeleton className="h-[420px] w-full rounded-lg" />
			</div>
		);
	}

	if (error || !agent) {
		return (
			<Card className="w-full">
				<CardHeader>
					<CardTitle>Settings unavailable</CardTitle>
					<CardDescription>{errorMessage(error ?? "Agent not found")}</CardDescription>
				</CardHeader>
			</Card>
		);
	}

	const normalizedDraftName = draftName.trim() || null;
	const currentCustomName = agent.display_name ?? null;
	const nameChanged = normalizedDraftName !== currentCustomName;
	const hasCustomAvatar = Boolean(agent.avatar_url);
	const isHosted = isHostedAgentEnvironment(agent);
	const isBusy =
		updateIdentity.isPending ||
		uploadMutation.isPending ||
		clearAvatar.isPending ||
		disconnect.isPending;
	const displayName = agentDisplayName(agent);
	const defaultDisplayName = agentDisplayName({ ...agent, display_name: null });
	const runtimeLabel = agentTypeLabel(agent.agent_type);
	const currentAvatarLabel = hasCustomAvatar ? "Custom upload" : `${runtimeLabel} default`;

	return (
		<div className="w-full">
			<input
				ref={fileInputRef}
				type="file"
				accept="image/png,image/jpeg,image/webp"
				className="hidden"
				onChange={onUploadChange}
			/>
			<Card className="gap-0 overflow-hidden py-0">
				<CardHeader className="border-b bg-muted/20 px-6 py-6">
					<div className="mx-auto flex max-w-full flex-col items-center gap-3 text-center">
						<AgentIcon
							agent={agent.agent_type}
							size="xl"
							identitySeed={agentIdentitySeed(agent)}
							avatarUrl={agent.avatar_url}
						/>
						<div className="min-w-0 space-y-1">
							<CardTitle className="max-w-full truncate">{displayName}</CardTitle>
							<CardDescription className="flex flex-wrap items-center justify-center gap-2">
								<span>{runtimeLabel}</span>
								<AgentSourceBadgeForEnvironment env={agent} compact showConnected />
							</CardDescription>
						</div>
					</div>
				</CardHeader>

				<CardContent className="divide-y px-0">
					<SettingsSection
						title="Display name"
						description="Use a short name that distinguishes this agent from others."
					>
						<div className="flex flex-col gap-2">
							<div className="flex flex-col gap-2 sm:flex-row">
								<Label htmlFor="agent-display-name" className="sr-only">
									Display name
								</Label>
								<Input
									id="agent-display-name"
									value={draftName}
									maxLength={120}
									placeholder={defaultDisplayName}
									onChange={(event) => setDraftName(event.target.value)}
								/>
								<Button
									type="button"
									size="sm"
									variant={nameChanged ? "default" : "outline"}
									className="sm:h-9"
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

					<SettingsSection
						title="Avatar"
						description="Shown in the sidebar, pickers, and agent lists."
					>
						<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
							<div className="flex min-w-0 items-center gap-3">
								<AgentIcon
									agent={agent.agent_type}
									size="lg"
									identitySeed={agentIdentitySeed(agent)}
									avatarUrl={agent.avatar_url}
								/>
								<div className="min-w-0">
									<div className="truncate text-sm font-medium">{currentAvatarLabel}</div>
									<div className="text-xs text-muted-foreground">Image up to 2 MB.</div>
								</div>
							</div>
							<div className="flex flex-wrap gap-2">
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

					{!isHosted ? (
						<SettingsSection
							title="Disconnect"
							description="Remove this connected agent from your dashboard."
						>
							<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
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
				</CardContent>
			</Card>
		</div>
	);
}
