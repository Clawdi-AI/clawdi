"use client";

import { useAuth, useUser } from "@clerk/nextjs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Key, Plus, Settings, Trash2, User } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { type ApiError, apiFetch } from "@/lib/api";
import type { ApiKey, ApiKeyCreated } from "@/lib/api-schemas";
import { cn } from "@/lib/utils";

type Section = "general" | "profile" | "api-keys";

const SECTIONS: { id: Section; label: string; icon: typeof Settings }[] = [
	{ id: "general", label: "General", icon: Settings },
	{ id: "profile", label: "Profile", icon: User },
	{ id: "api-keys", label: "API Keys", icon: Key },
];

interface SettingsDialogProps {
	open: boolean;
	onClose: () => void;
	initialSection?: Section;
}

export function SettingsDialog({ open, onClose, initialSection = "general" }: SettingsDialogProps) {
	const [section, setSection] = useState<Section>(initialSection);

	useEffect(() => {
		if (open) setSection(initialSection);
	}, [open, initialSection]);

	return (
		<Dialog open={open} onOpenChange={(next) => !next && onClose()}>
			<DialogContent
				className="flex h-[min(680px,85vh)] max-w-3xl flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
				showCloseButton
			>
				<DialogHeader className="border-b px-5 py-3">
					<DialogTitle className="text-base">Settings</DialogTitle>
				</DialogHeader>

				<div className="flex min-h-0 flex-1">
					{/* Section nav */}
					<nav
						aria-label="Settings sections"
						className="w-[180px] shrink-0 space-y-0.5 border-r p-2"
					>
						{SECTIONS.map((s) => (
							<Button
								key={s.id}
								variant="ghost"
								size="sm"
								onClick={() => setSection(s.id)}
								className={cn(
									"w-full justify-start font-normal",
									section === s.id && "bg-muted font-medium text-foreground",
								)}
							>
								<s.icon />
								{s.label}
							</Button>
						))}
					</nav>

					{/* Panel */}
					<div className="flex-1 overflow-y-auto p-6">
						{section === "general" ? <GeneralPanel /> : null}
						{section === "profile" ? <ProfilePanel /> : null}
						{section === "api-keys" ? <ApiKeysPanel /> : null}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function GeneralPanel() {
	return (
		<div className="space-y-4">
			<div>
				<h3 className="text-lg font-medium">General</h3>
				<p className="mt-1 text-sm text-muted-foreground">
					General settings for your Clawdi Cloud account.
				</p>
			</div>
		</div>
	);
}

function ProfilePanel() {
	const { user } = useUser();
	const initial = user?.fullName?.[0] ?? user?.primaryEmailAddress?.emailAddress?.[0] ?? "U";

	return (
		<div className="space-y-4">
			<div>
				<h3 className="text-lg font-medium">Profile</h3>
			</div>
			<div className="flex items-center gap-4">
				<Avatar className="size-14">
					{user?.imageUrl ? <AvatarImage src={user.imageUrl} alt={user.fullName ?? ""} /> : null}
					<AvatarFallback>{initial}</AvatarFallback>
				</Avatar>
				<div>
					<div className="font-medium">{user?.fullName ?? "Anonymous"}</div>
					<div className="text-sm text-muted-foreground">
						{user?.primaryEmailAddress?.emailAddress}
					</div>
				</div>
			</div>
		</div>
	);
}

function ApiKeysPanel() {
	const { getToken } = useAuth();
	const queryClient = useQueryClient();
	const [newLabel, setNewLabel] = useState("");
	const [createdKey, setCreatedKey] = useState<string | null>(null);

	const { data: keys, isLoading } = useQuery({
		queryKey: ["api-keys"],
		queryFn: async () => {
			const token = await getToken();
			if (!token) throw new Error("Not authenticated");
			return apiFetch<ApiKey[]>("/api/auth/keys", token);
		},
	});

	const createKey = useMutation({
		mutationFn: async (label: string) => {
			const token = await getToken();
			if (!token) throw new Error("Not authenticated");
			return apiFetch<ApiKeyCreated>("/api/auth/keys", token, {
				method: "POST",
				body: JSON.stringify({ label }),
			});
		},
		onSuccess: (data) => {
			setCreatedKey(data.raw_key);
			setNewLabel("");
			queryClient.invalidateQueries({ queryKey: ["api-keys"] });
		},
		onError: (e: ApiError) => toast.error("Couldn't create key", { description: e.detail }),
	});

	const revokeKey = useMutation({
		mutationFn: async (keyId: string) => {
			const token = await getToken();
			if (!token) throw new Error("Not authenticated");
			return apiFetch<unknown>(`/api/auth/keys/${keyId}`, token, { method: "DELETE" });
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["api-keys"] });
			toast.success("Key revoked");
		},
		onError: (e: ApiError) => toast.error("Couldn't revoke key", { description: e.detail }),
	});

	return (
		<div className="space-y-4">
			<div>
				<h3 className="text-lg font-medium">API Keys</h3>
				<p className="mt-1 text-sm text-muted-foreground">
					Create API keys for the CLI. Run{" "}
					<code className="rounded bg-muted px-1 py-0.5 text-xs">clawdi login</code> and paste the
					key.
				</p>
			</div>

			{/* Create form */}
			<form
				className="space-y-2"
				onSubmit={(e) => {
					e.preventDefault();
					if (newLabel) createKey.mutate(newLabel);
				}}
			>
				<Label htmlFor="new-key-label" className="sr-only">
					New API key label
				</Label>
				<div className="flex gap-2">
					<Input
						id="new-key-label"
						value={newLabel}
						onChange={(e) => setNewLabel(e.target.value)}
						placeholder="Key label (e.g. my-laptop)"
					/>
					<Button type="submit" disabled={!newLabel || createKey.isPending}>
						<Plus />
						Create
					</Button>
				</div>
			</form>

			{/* Created key banner */}
			{createdKey ? (
				<div className="space-y-2 rounded-lg border border-primary/20 bg-primary/5 p-4">
					<div className="text-sm font-medium text-primary">
						Key created — copy it now, it won't be shown again.
					</div>
					<div className="flex items-center gap-2">
						<code className="flex-1 break-all rounded bg-muted px-3 py-2 font-mono text-xs">
							{createdKey}
						</code>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							onClick={() => {
								navigator.clipboard.writeText(createdKey);
								toast.success("Copied to clipboard");
							}}
							aria-label="Copy key"
						>
							<Copy />
						</Button>
					</div>
				</div>
			) : null}

			{/* Key list */}
			{isLoading ? (
				<div className="space-y-2">
					{[1, 2].map((i) => (
						<Skeleton key={i} className="h-14 w-full" />
					))}
				</div>
			) : keys?.length ? (
				<div className="divide-y rounded-lg border">
					{keys.map((k) => (
						<div key={k.id} className="flex items-center justify-between gap-3 px-4 py-3">
							<div className="min-w-0">
								<div className="flex items-center gap-2 text-sm font-medium">
									<span className="truncate">{k.label}</span>
									{k.revoked_at ? <Badge variant="destructive">Revoked</Badge> : null}
								</div>
								<div className="mt-0.5 truncate text-xs text-muted-foreground">
									{k.key_prefix}… · Created {new Date(k.created_at).toLocaleDateString()}
									{k.last_used_at
										? ` · Last used ${new Date(k.last_used_at).toLocaleDateString()}`
										: ""}
								</div>
							</div>
							{!k.revoked_at ? (
								<Button
									type="button"
									variant="ghost"
									size="icon"
									onClick={() => revokeKey.mutate(k.id)}
									disabled={revokeKey.isPending}
									aria-label="Revoke key"
									className="text-muted-foreground hover:text-destructive"
								>
									<Trash2 />
								</Button>
							) : null}
						</div>
					))}
				</div>
			) : (
				<p className="text-sm text-muted-foreground">No API keys yet.</p>
			)}
		</div>
	);
}
