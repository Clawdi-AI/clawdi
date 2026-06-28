"use client";

import type { components } from "@clawdi/shared/api";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, RotateCcw, Save, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import {
	AgentSourceBadgeForEnvironment,
	agentDisplayName,
	agentIdentitySeed,
	agentTypeLabel,
} from "@/components/dashboard/agent-label";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { AGENT_AVATAR_PRESETS } from "@/lib/agent-avatar-presets";
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
}: {
	title: string;
	description?: string;
	children: React.ReactNode;
}) {
	return (
		<section className="grid gap-4 border-t px-5 py-4 md:grid-cols-[180px_minmax(0,1fr)]">
			<div>
				<div className="text-sm font-medium">{title}</div>
				{description ? (
					<p className="mt-1 max-w-48 text-xs leading-5 text-muted-foreground">{description}</p>
				) : null}
			</div>
			<div className="min-w-0">{children}</div>
		</section>
	);
}

export function AgentSettingsPanel({ environmentId }: { environmentId: string }) {
	const api = useApi();
	const queryClient = useQueryClient();
	const uploadAvatar = useAgentAvatarUploader();
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const [draftName, setDraftName] = useState("");
	const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
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
			setAvatarPickerOpen(false);
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
			setAvatarPickerOpen(false);
			toast.success("Avatar cleared");
		},
		onError: (e) => toast.error("Couldn't clear avatar", { description: errorMessage(e) }),
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
			<div className="max-w-4xl">
				<Skeleton className="h-[360px] w-full rounded-lg" />
			</div>
		);
	}

	if (error || !agent) {
		return (
			<Card>
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
	const selectedPreset = agent.avatar_preset ?? null;
	const hasCustomAvatar = Boolean(agent.avatar_url && !selectedPreset);
	const isBusy = updateIdentity.isPending || uploadMutation.isPending || clearAvatar.isPending;
	const hasAvatarPresets = AGENT_AVATAR_PRESETS.length > 0;
	const displayName = agentDisplayName(agent);
	const defaultDisplayName = agentDisplayName({ ...agent, display_name: null });
	const runtimeLabel = agentTypeLabel(agent.agent_type);
	const selectedPresetLabel =
		AGENT_AVATAR_PRESETS.find((preset) => preset.id === selectedPreset)?.label ?? null;
	const currentAvatarLabel = selectedPresetLabel
		? `${selectedPresetLabel} preset`
		: hasCustomAvatar
			? "Custom upload"
			: `${runtimeLabel} default`;
	const hasCustomIdentity = Boolean(agent.avatar_url || agent.avatar_preset);

	return (
		<div className="max-w-4xl">
			<input
				ref={fileInputRef}
				type="file"
				accept="image/png,image/jpeg,image/webp"
				className="hidden"
				onChange={onUploadChange}
			/>
			<Card className="gap-0 overflow-hidden py-0">
				<CardHeader className="py-5">
					<Popover open={avatarPickerOpen} onOpenChange={setAvatarPickerOpen}>
						<div className="flex min-w-0 items-center gap-4">
							<PopoverTrigger asChild>
								<button
									type="button"
									className="group relative size-12 shrink-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
									aria-label="Change agent avatar"
								>
									<AgentIcon
										agent={agent.agent_type}
										size="xl"
										identitySeed={agentIdentitySeed(agent)}
										avatarUrl={agent.avatar_url}
										avatarPreset={agent.avatar_preset}
									/>
									<span className="absolute inset-0 flex items-center justify-center rounded-md bg-foreground/45 text-background opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
										<Camera aria-hidden="true" className="size-4" />
									</span>
								</button>
							</PopoverTrigger>
							<div className="min-w-0">
								<div className="flex min-w-0 items-center gap-2">
									<CardTitle className="truncate">{displayName}</CardTitle>
									<AgentSourceBadgeForEnvironment
										env={agent}
										compact
										showConnected
										className="text-muted-foreground"
									/>
								</div>
								<CardDescription className="mt-1 truncate">{runtimeLabel}</CardDescription>
							</div>
						</div>
						<PopoverContent align="start" className="w-80">
							<PopoverHeader>
								<PopoverTitle>Change avatar</PopoverTitle>
								<PopoverDescription>
									Choose a preset or upload a PNG, JPEG, or WebP image up to 2 MB.
								</PopoverDescription>
							</PopoverHeader>
							<div className="mt-4 flex flex-col gap-3">
								{hasCustomAvatar || hasAvatarPresets ? (
									<div className="grid grid-cols-3 gap-2">
										{hasCustomAvatar ? (
											<div className="flex flex-col items-center gap-1 rounded-md border border-primary bg-primary/5 p-2 text-xs ring-1 ring-primary/25">
												<AgentIcon
													agent={agent.agent_type}
													size="lg"
													identitySeed={agentIdentitySeed(agent)}
													avatarUrl={agent.avatar_url}
												/>
												<span className="max-w-full truncate">Custom</span>
											</div>
										) : null}
										{AGENT_AVATAR_PRESETS.map((preset) => (
											<button
												key={preset.id}
												type="button"
												disabled={isBusy}
												onClick={() =>
													updateIdentity.mutate(
														{ avatar_preset: preset.id },
														{ onSuccess: () => setAvatarPickerOpen(false) },
													)
												}
												className={cn(
													"flex flex-col items-center gap-1 rounded-md border bg-background p-2 text-xs transition-colors hover:border-foreground/20 hover:bg-accent/60 disabled:pointer-events-none disabled:opacity-50",
													selectedPreset === preset.id &&
														"border-primary bg-primary/5 text-foreground ring-1 ring-primary/25",
												)}
												aria-pressed={selectedPreset === preset.id}
												aria-label={`Use ${preset.label} avatar`}
											>
												<img src={preset.src} alt="" className="size-8 rounded-md object-cover" />
												<span className="max-w-full truncate">{preset.label}</span>
											</button>
										))}
									</div>
								) : null}
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
										disabled={isBusy || !hasCustomIdentity}
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
						</PopoverContent>
					</Popover>
				</CardHeader>

				<CardContent className="px-0">
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
									avatarPreset={agent.avatar_preset}
								/>
								<div className="min-w-0">
									<div className="truncate text-sm font-medium">{currentAvatarLabel}</div>
									<div className="truncate text-xs text-muted-foreground">
										PNG, JPEG, or WebP. Max 2 MB.
									</div>
								</div>
							</div>
							<div className="flex flex-wrap gap-2">
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={isBusy}
									onClick={() => setAvatarPickerOpen(true)}
								>
									<Camera data-icon="inline-start" />
									Change avatar
								</Button>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									disabled={isBusy || !hasCustomIdentity}
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
				</CardContent>
			</Card>
		</div>
	);
}
