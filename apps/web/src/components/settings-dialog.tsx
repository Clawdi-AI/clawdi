"use client";

import { useUser } from "@clerk/nextjs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Copy, Key, Plus, Settings, Trash2, User } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
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
import { type ApiError, unwrap, useApi } from "@/lib/api";
import type { ApiKey } from "@/lib/api-schemas";
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
				className="flex h-[85vh] max-h-[640px] w-[calc(100%-1rem)] max-w-3xl flex-col gap-0 overflow-hidden p-0 sm:h-[560px] sm:max-h-[85vh] sm:max-w-3xl"
				showCloseButton
			>
				<DialogHeader className="sr-only">
					<DialogTitle>Settings</DialogTitle>
					<DialogDescription>
						Account, profile, and API key management for Clawdi Cloud.
					</DialogDescription>
				</DialogHeader>

				<div className="flex min-h-0 flex-1 flex-col sm:grid sm:grid-cols-[200px_1fr]">
					<nav
						aria-label="Settings sections"
						className="flex shrink-0 gap-1 border-b p-2 overflow-x-auto sm:flex-col sm:border-r sm:border-b-0 sm:p-3 sm:overflow-x-visible"
					>
						{SECTIONS.map((s) => (
							<button
								key={s.id}
								type="button"
								onClick={() => setSection(s.id)}
								className={cn(
									"flex shrink-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-left transition-colors",
									section === s.id
										? "bg-accent text-accent-foreground"
										: "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
								)}
							>
								<s.icon className="size-4" />
								{s.label}
							</button>
						))}
					</nav>

					<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
						<div className="flex flex-col gap-6 px-6 py-6">
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
			<PanelHeader title="General" />
			<div className="flex items-center justify-between">
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
			<PanelHeader title="Profile" />
			<div className="flex items-center gap-4">
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
	const api = useApi();
	const queryClient = useQueryClient();
	const [newLabel, setNewLabel] = useState("");
	const [createdKey, setCreatedKey] = useState<string | null>(null);

	const { data: keys, isLoading } = useQuery({
		queryKey: ["api-keys"],
		queryFn: async () => unwrap(await api.GET("/api/auth/keys")),
	});

	const createKey = useMutation({
		mutationFn: async (label: string) =>
			unwrap(await api.POST("/api/auth/keys", { body: { label } })),
		onSuccess: (data) => {
			setCreatedKey(data.raw_key);
			setNewLabel("");
			queryClient.invalidateQueries({ queryKey: ["api-keys"] });
		},
		onError: (e: ApiError) => toast.error("Couldn't create key", { description: e.detail }),
	});

	const revokeKey = useMutation({
		mutationFn: async (keyId: string) =>
			unwrap(
				await api.DELETE("/api/auth/keys/{key_id}", {
					params: { path: { key_id: keyId } },
				}),
			),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["api-keys"] });
			toast.success("Key revoked");
		},
		onError: (e: ApiError) => toast.error("Couldn't revoke key", { description: e.detail }),
	});

	const columns = useMemo<ColumnDef<ApiKey>[]>(
		() => [
			{
				accessorKey: "label",
				header: "Label",
				cell: ({ row }) => (
					<div className="flex items-center gap-2">
						<span className="font-medium">{row.original.label}</span>
						{row.original.revoked_at ? <Badge variant="destructive">Revoked</Badge> : null}
					</div>
				),
			},
			{
				accessorKey: "key_prefix",
				header: "Prefix",
				cell: ({ row }) => (
					<span className="font-mono text-xs text-muted-foreground">
						{row.original.key_prefix}…
					</span>
				),
			},
			{
				accessorKey: "created_at",
				header: "Created",
				cell: ({ row }) => (
					<span className="text-xs text-muted-foreground">
						{new Date(row.original.created_at).toLocaleDateString()}
					</span>
				),
			},
			{
				accessorKey: "last_used_at",
				header: "Last used",
				cell: ({ row }) =>
					row.original.last_used_at ? (
						<span className="text-xs text-muted-foreground">
							{new Date(row.original.last_used_at).toLocaleDateString()}
						</span>
					) : (
						<span className="text-xs text-muted-foreground">—</span>
					),
			},
			{
				id: "actions",
				header: "",
				cell: ({ row }) =>
					!row.original.revoked_at ? (
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							onClick={() => {
								// Revoking a key in-use stops sync on whichever
								// machine holds it. Cannot be un-revoked, so
								// confirm with explicit blast radius.
								const ok = window.confirm(
									`Revoke "${row.original.label}"?\n\n` +
										"If a machine is still using this key, sync will stop on it within a minute. " +
										"You'd need to log in again from that machine to resume.",
								);
								if (ok) revokeKey.mutate(row.original.id);
							}}
							disabled={revokeKey.isPending}
							aria-label="Revoke key"
							className="text-muted-foreground hover:text-destructive"
						>
							<Trash2 className="size-3.5" />
						</Button>
					) : null,
				size: 40,
			},
		],
		[revokeKey],
	);

	return (
		<>
			<PanelHeader
				title="API Keys"
				description={
					<>
						On a laptop,{" "}
						<code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
							clawdi auth login
						</code>{" "}
						handles auth automatically — you don&apos;t need to touch this. Create a key here when
						you&apos;re setting up a server or container that can&apos;t open a browser, then paste
						it into{" "}
						<code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
							CLAWDI_AUTH_TOKEN
						</code>{" "}
						(this is the env var the CLI and{" "}
						<code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">clawdi serve</code>{" "}
						actually read).
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

			<DataTable
				columns={columns}
				data={keys ?? []}
				isLoading={isLoading}
				emptyMessage="No API keys yet."
			/>
		</>
	);
}
