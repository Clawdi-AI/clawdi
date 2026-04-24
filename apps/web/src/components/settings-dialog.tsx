"use client";

import { useAuth, useUser } from "@clerk/nextjs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Key, Plus, Settings, Trash2, User } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
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

export function SettingsDialog({
	open,
	onClose,
	initialSection = "general",
}: {
	open: boolean;
	onClose: () => void;
	initialSection?: Section;
}) {
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
				{/* Accessible title + description live in the sidebar column visually;
				    the radix-required DialogTitle/Description are visually hidden so
				    the header row stays clean. */}
				<DialogHeader className="sr-only">
					<DialogTitle>Settings</DialogTitle>
					<DialogDescription>
						Account, profile, and API key management for Clawdi Cloud.
					</DialogDescription>
				</DialogHeader>

				<div className="grid min-h-0 flex-1 grid-cols-[200px_1fr]">
					{/* Left column — section nav, styled like a sidebar. */}
					<nav aria-label="Settings sections" className="flex flex-col border-r bg-muted/30 p-3">
						<div className="mb-3 px-2">
							<div className="text-sm font-semibold">Settings</div>
						</div>
						<div className="flex flex-col gap-0.5">
							{SECTIONS.map((s) => (
								<button
									key={s.id}
									type="button"
									onClick={() => setSection(s.id)}
									className={cn(
										"flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-left transition-colors",
										section === s.id
											? "bg-background font-medium text-foreground shadow-sm"
											: "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
									)}
								>
									<s.icon className="size-4" />
									{s.label}
								</button>
							))}
						</div>
					</nav>

					{/* Right column — scrollable panel. */}
					<div className="flex min-w-0 flex-col overflow-y-auto">
						<div className="flex flex-col gap-6 px-8 py-6">
							{section === "general" ? <GeneralPanel /> : null}
							{section === "profile" ? <ProfilePanel /> : null}
							{section === "api-keys" ? <ApiKeysPanel /> : null}
						</div>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

// ---------------------------------------------------------------------------
// Section header — consistent h3 + description across panels.
// ---------------------------------------------------------------------------

function PanelHeader({ title, description }: { title: string; description?: React.ReactNode }) {
	return (
		<div className="space-y-1">
			<h3 className="text-base font-semibold">{title}</h3>
			{description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
		</div>
	);
}

// ---------------------------------------------------------------------------
// General — theme + app info. Keeps the panel from feeling empty.
// ---------------------------------------------------------------------------

function GeneralPanel() {
	const { theme, setTheme } = useTheme();

	return (
		<>
			<PanelHeader
				title="General"
				description="App-wide preferences for your Clawdi Cloud dashboard."
			/>

			<div className="flex items-center justify-between border-t pt-4">
				<div className="space-y-0.5">
					<Label htmlFor="settings-theme">Theme</Label>
					<p className="text-xs text-muted-foreground">
						Light, dark, or follow the system preference.
					</p>
				</div>
				<Select value={theme ?? "system"} onValueChange={setTheme}>
					<SelectTrigger id="settings-theme" className="w-[160px]">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="light">Light</SelectItem>
						<SelectItem value="dark">Dark</SelectItem>
						<SelectItem value="system">System</SelectItem>
					</SelectContent>
				</Select>
			</div>
		</>
	);
}

// ---------------------------------------------------------------------------
// Profile — read-only for now; Clerk owns account editing.
// ---------------------------------------------------------------------------

function ProfilePanel() {
	const { user } = useUser();
	const initial = user?.fullName?.[0] ?? user?.primaryEmailAddress?.emailAddress?.[0] ?? "U";

	return (
		<>
			<PanelHeader
				title="Profile"
				description="Edit your name and avatar from the Clerk-hosted user profile."
			/>

			<div className="flex items-center gap-4 border-t pt-4">
				<Avatar className="size-14">
					{user?.imageUrl ? <AvatarImage src={user.imageUrl} alt={user.fullName ?? ""} /> : null}
					<AvatarFallback>{initial}</AvatarFallback>
				</Avatar>
				<div className="space-y-0.5">
					<div className="text-sm font-medium">{user?.fullName ?? "Anonymous"}</div>
					<div className="text-sm text-muted-foreground">
						{user?.primaryEmailAddress?.emailAddress}
					</div>
				</div>
			</div>
		</>
	);
}

// ---------------------------------------------------------------------------
// API Keys — CLI-facing bearer tokens.
// ---------------------------------------------------------------------------

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
		<>
			<PanelHeader
				title="API Keys"
				description={
					<>
						Create bearer keys for the CLI. Run{" "}
						<code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">clawdi login</code> and
						paste the key when prompted.
					</>
				}
			/>

			{/* Create form */}
			<form
				className="flex gap-2 border-t pt-4"
				onSubmit={(e) => {
					e.preventDefault();
					if (newLabel) createKey.mutate(newLabel);
				}}
			>
				<Label htmlFor="new-key-label" className="sr-only">
					New API key label
				</Label>
				<Input
					id="new-key-label"
					value={newLabel}
					onChange={(e) => setNewLabel(e.target.value)}
					placeholder="Key label (e.g. my-laptop)"
					className="flex-1"
				/>
				<Button type="submit" disabled={!newLabel || createKey.isPending}>
					<Plus />
					Create
				</Button>
			</form>

			{/* Created key banner */}
			{createdKey ? (
				<div className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-4">
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
		</>
	);
}
