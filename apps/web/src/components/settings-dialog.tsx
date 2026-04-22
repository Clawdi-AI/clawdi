"use client";

import { useAuth, useUser } from "@clerk/nextjs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Key, Plus, Settings, Trash2, User, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";

type Section = "general" | "profile" | "api-keys";

interface ApiKeySummary {
	id: string;
	label: string;
	key_prefix: string;
	created_at: string;
	last_used_at: string | null;
	revoked_at: string | null;
}

interface CreatedApiKey {
	id: string;
	raw_key: string;
	label: string;
}

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
	const dialogRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (open) setSection(initialSection);
	}, [open, initialSection]);

	useEffect(() => {
		if (!open) return;
		function handleEsc(e: KeyboardEvent) {
			if (e.key === "Escape") onClose();
		}
		document.addEventListener("keydown", handleEsc);
		return () => document.removeEventListener("keydown", handleEsc);
	}, [open, onClose]);

	if (!open) return null;

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center">
			{/* Backdrop */}
			<button
				type="button"
				aria-label="Close dialog"
				className="absolute inset-0 bg-black/50 animate-in fade-in duration-200"
				onClick={onClose}
			/>

			{/* Dialog */}
			<div
				ref={dialogRef}
				className={cn(
					"relative flex flex-col bg-background border border-border rounded-xl shadow-xl overflow-hidden",
					"w-[calc(100vw-2rem)] max-w-3xl h-[min(680px,85vh)]",
					"animate-in fade-in zoom-in-95 duration-200",
				)}
			>
				{/* Header */}
				<div className="flex items-center justify-between border-b border-border px-5 py-3">
					<h2 className="text-base font-semibold">Settings</h2>
					<button
						type="button"
						onClick={onClose}
						className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
					>
						<X className="size-4" />
					</button>
				</div>

				{/* Body */}
				<div className="flex min-h-0 flex-1">
					{/* Sidebar nav */}
					<nav className="w-[170px] shrink-0 border-r border-border px-2 py-3 space-y-0.5">
						{SECTIONS.map((s) => (
							<button
								key={s.id}
								type="button"
								onClick={() => setSection(s.id)}
								className={cn(
									"w-full flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
									section === s.id
										? "bg-muted font-medium text-foreground"
										: "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
								)}
							>
								<s.icon className="size-4 shrink-0" />
								{s.label}
							</button>
						))}
					</nav>

					{/* Content */}
					<div className="flex-1 overflow-y-auto p-6">
						{section === "general" && <GeneralPanel />}
						{section === "profile" && <ProfilePanel />}
						{section === "api-keys" && <ApiKeysPanel />}
					</div>
				</div>
			</div>
		</div>
	);
}

function GeneralPanel() {
	return (
		<div className="space-y-4">
			<h3 className="text-lg font-medium">General</h3>
			<p className="text-sm text-muted-foreground">
				General settings for your Clawdi Cloud account.
			</p>
		</div>
	);
}

function ProfilePanel() {
	const { user } = useUser();
	return (
		<div className="space-y-4">
			<h3 className="text-lg font-medium">Profile</h3>
			<div className="space-y-3">
				<div className="flex items-center gap-4">
					{user?.imageUrl && <img src={user.imageUrl} alt="" className="size-14 rounded-full" />}
					<div>
						<div className="font-medium">{user?.fullName}</div>
						<div className="text-sm text-muted-foreground">
							{user?.primaryEmailAddress?.emailAddress}
						</div>
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
			return apiFetch<ApiKeySummary[]>("/api/auth/keys", token);
		},
	});

	const createKey = useMutation({
		mutationFn: async (label: string) => {
			const token = await getToken();
			if (!token) throw new Error("Not authenticated");
			return apiFetch<CreatedApiKey>("/api/auth/keys", token, {
				method: "POST",
				body: JSON.stringify({ label }),
			});
		},
		onSuccess: (data) => {
			setCreatedKey(data.raw_key);
			setNewLabel("");
			queryClient.invalidateQueries({ queryKey: ["api-keys"] });
		},
	});

	const revokeKey = useMutation({
		mutationFn: async (keyId: string) => {
			const token = await getToken();
			if (!token) throw new Error("Not authenticated");
			return apiFetch<unknown>(`/api/auth/keys/${keyId}`, token, { method: "DELETE" });
		},
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["api-keys"] }),
	});

	return (
		<div className="space-y-4">
			<div>
				<h3 className="text-lg font-medium">API Keys</h3>
				<p className="text-sm text-muted-foreground mt-1">
					Create API keys for the CLI. Run{" "}
					<code className="bg-muted px-1 py-0.5 rounded text-xs">clawdi login</code> and paste the
					key.
				</p>
			</div>

			{/* Create */}
			<div className="flex gap-2">
				<input
					type="text"
					value={newLabel}
					onChange={(e) => setNewLabel(e.target.value)}
					placeholder="Key label (e.g. my-laptop)"
					className="flex-1 border border-input bg-background rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
					onKeyDown={(e) => {
						if (e.key === "Enter" && newLabel) createKey.mutate(newLabel);
					}}
				/>
				<button
					type="button"
					onClick={() => newLabel && createKey.mutate(newLabel)}
					disabled={!newLabel || createKey.isPending}
					className="flex items-center gap-1.5 bg-primary text-primary-foreground rounded-lg px-4 py-2 text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
				>
					<Plus className="size-4" />
					Create
				</button>
			</div>

			{/* Created key banner */}
			{createdKey && (
				<div className="bg-primary/5 border border-primary/20 rounded-lg p-4 space-y-2">
					<div className="text-sm font-medium text-primary">
						Key created! Copy it now — it won't be shown again.
					</div>
					<div className="flex items-center gap-2">
						<code className="flex-1 bg-muted rounded px-3 py-2 text-xs font-mono break-all">
							{createdKey}
						</code>
						<button
							type="button"
							onClick={() => navigator.clipboard.writeText(createdKey)}
							className="p-2 hover:bg-muted rounded-lg transition-colors"
							title="Copy"
						>
							<Copy className="size-4" />
						</button>
					</div>
				</div>
			)}

			{/* Key list */}
			{isLoading ? (
				<div className="text-sm text-muted-foreground">Loading...</div>
			) : keys?.length ? (
				<div className="border border-border rounded-lg divide-y divide-border">
					{keys.map((k) => (
						<div key={k.id} className="flex items-center justify-between px-4 py-3">
							<div>
								<div className="text-sm font-medium">{k.label}</div>
								<div className="text-xs text-muted-foreground mt-0.5">
									{k.key_prefix}...
									{" · "}Created {new Date(k.created_at).toLocaleDateString()}
									{k.last_used_at && (
										<>
											{" · "}Last used {new Date(k.last_used_at).toLocaleDateString()}
										</>
									)}
									{k.revoked_at && <span className="text-destructive ml-1">Revoked</span>}
								</div>
							</div>
							{!k.revoked_at && (
								<button
									type="button"
									onClick={() => revokeKey.mutate(k.id)}
									className="p-2 text-muted-foreground hover:text-destructive hover:bg-muted rounded-lg transition-colors"
									title="Revoke"
								>
									<Trash2 className="size-4" />
								</button>
							)}
						</div>
					))}
				</div>
			) : (
				<div className="text-sm text-muted-foreground">No API keys yet.</div>
			)}
		</div>
	);
}
