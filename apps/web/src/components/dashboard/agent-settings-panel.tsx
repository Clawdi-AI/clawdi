"use client";

import type { components } from "@clawdi/shared/api";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ImageIcon, Save, Trash2, Upload } from "lucide-react";
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
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

export function AgentSettingsPanel({ environmentId }: { environmentId: string }) {
	const api = useApi();
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
			<div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(260px,360px)]">
				<Skeleton className="h-56 w-full" />
				<Skeleton className="h-56 w-full" />
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

	const nameChanged = draftName.trim() !== (agent.display_name ?? "");
	const selectedPreset = agent.avatar_preset ?? null;
	const isBusy = updateIdentity.isPending || uploadMutation.isPending || clearAvatar.isPending;
	const hasAvatarPresets = AGENT_AVATAR_PRESETS.length > 0;

	return (
		<div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,380px)]">
			<Card>
				<CardHeader>
					<CardTitle>Identity</CardTitle>
					<CardDescription>Set the name and avatar used across the dashboard.</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-5">
					<div className="flex items-center gap-4 rounded-md border bg-background/60 p-4">
						<AgentIcon
							agent={agent.agent_type}
							size="xl"
							identitySeed={agentIdentitySeed(agent)}
							avatarUrl={agent.avatar_url}
							avatarPreset={agent.avatar_preset}
						/>
						<div className="min-w-0">
							<div className="flex items-center gap-2">
								<div className="truncate text-base font-semibold">{agentDisplayName(agent)}</div>
								<AgentSourceBadgeForEnvironment env={agent} compact />
							</div>
							<div className="mt-1 text-sm text-muted-foreground">
								{agentTypeLabel(agent.agent_type)}
							</div>
						</div>
					</div>

					<div className="flex flex-col gap-2">
						<Label htmlFor="agent-display-name">Display name</Label>
						<Input
							id="agent-display-name"
							value={draftName}
							maxLength={120}
							placeholder={agentDisplayName(agent)}
							onChange={(event) => setDraftName(event.target.value)}
						/>
					</div>
				</CardContent>
				<CardFooter className="gap-2">
					<Button
						size="sm"
						disabled={!nameChanged || updateIdentity.isPending}
						onClick={() => updateIdentity.mutate({ display_name: draftName })}
					>
						{updateIdentity.isPending ? <Spinner data-icon="inline-start" /> : <Save />}
						Save name
					</Button>
					<Button
						size="sm"
						variant="outline"
						disabled={!agent.display_name || updateIdentity.isPending}
						onClick={() => updateIdentity.mutate({ display_name: null })}
					>
						Reset name
					</Button>
				</CardFooter>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>Avatar</CardTitle>
					<CardDescription>
						{hasAvatarPresets
							? "Choose a product avatar or upload an image file."
							: "Upload an image file for this agent."}
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					{hasAvatarPresets ? (
						<div className="grid grid-cols-3 gap-2">
							{AGENT_AVATAR_PRESETS.map((preset) => (
								<button
									key={preset.id}
									type="button"
									disabled={isBusy}
									onClick={() => updateIdentity.mutate({ avatar_preset: preset.id })}
									className={cn(
										"flex flex-col items-center gap-1 rounded-md border p-2 text-xs transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50",
										selectedPreset === preset.id
											? "border-primary bg-accent text-accent-foreground"
											: "bg-background",
									)}
									aria-pressed={selectedPreset === preset.id}
								>
									<img src={preset.src} alt="" className="size-12 rounded-md object-cover" />
									<span className="max-w-full truncate">{preset.label}</span>
								</button>
							))}
						</div>
					) : null}

					<input
						ref={fileInputRef}
						type="file"
						accept="image/png,image/jpeg,image/webp"
						className="hidden"
						onChange={onUploadChange}
					/>
					<Button
						type="button"
						variant="outline"
						disabled={isBusy}
						onClick={() => fileInputRef.current?.click()}
					>
						{uploadMutation.isPending ? <Spinner data-icon="inline-start" /> : <Upload />}
						Upload image
					</Button>
				</CardContent>
				<CardFooter className="gap-2">
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={isBusy || (!agent.avatar_url && !agent.avatar_preset)}
						onClick={() => clearAvatar.mutate()}
					>
						{clearAvatar.isPending ? <Spinner data-icon="inline-start" /> : <Trash2 />}
						Clear avatar
					</Button>
					<div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
						<ImageIcon className="size-3.5 shrink-0" />
						<span className="truncate">PNG, JPEG, or WebP. Max 2 MB.</span>
					</div>
				</CardFooter>
			</Card>
		</div>
	);
}
