"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, ClipboardPaste, Plus, Share2, Trash2 } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { useSetBreadcrumbTitle } from "@/components/breadcrumb-title";
import { displayProjectName, isCustomProject } from "@/components/projects/project-metadata";
import { ShareProjectDialog } from "@/components/sharing/share-project-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
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
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { unwrap, useApi } from "@/lib/api";
import type { components } from "@/lib/api-schemas";
import { identityFor } from "@/lib/identity";
import { cn, errorMessage } from "@/lib/utils";

type VaultSummary = components["schemas"]["VaultResponse"];
type ProjectRow = components["schemas"]["ProjectResponse"];

/* Vault detail (journeys J5 + J6): a real page for one secret bundle —
 * keys (names only; values stay server-side), paste-to-import, project
 * attachments, and the guided "Share keys" chain. */

export default function VaultDetailPage() {
	const params = useParams<{ slug: string }>();
	const slug = decodeURIComponent(params.slug);
	const api = useApi();
	const qc = useQueryClient();
	const router = useRouter();
	// Content first, inputs on demand (taste audit #2).
	const [showAddKey, setShowAddKey] = useState(false);

	const vaults = useQuery({
		queryKey: ["vaults", "all"],
		queryFn: async () =>
			unwrap(await api.GET("/api/vault", { params: { query: { page_size: 200 } } })),
	});
	const vault: VaultSummary | null = vaults.data?.items.find((v) => v.slug === slug) ?? null;
	const isOwner = vault?.is_owner !== false;
	const anyProjectId = vault?.project_ids?.[0];

	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: async (): Promise<ProjectRow[]> => unwrap(await api.GET("/api/projects")),
	});
	const projectById = useMemo(
		() => new Map((projects.data ?? []).map((p) => [p.id, p])),
		[projects.data],
	);

	const keys = useQuery({
		queryKey: ["vault-items", slug, anyProjectId],
		queryFn: async () =>
			unwrap(
				await api.GET("/api/vault/{slug}/items", {
					params: { path: { slug }, query: { project_id: anyProjectId ?? undefined } },
				}),
			),
		enabled: !!vault,
	});
	const keyNames = useMemo(() => {
		if (!keys.data) return [];
		return Object.entries(keys.data).flatMap(([section, names]) =>
			names.map((name) => ({ section, name })),
		);
	}, [keys.data]);

	const refresh = () => {
		qc.invalidateQueries({ queryKey: ["vaults"] });
		qc.invalidateQueries({ queryKey: ["vault-items", slug] });
	};

	const upsertKeys = useMutation({
		mutationFn: async (fields: Record<string, string>) => {
			if (!anyProjectId) throw new Error("Attach this vault to a Project first");
			return unwrap(
				await api.PUT("/api/vault/{slug}/items", {
					params: { path: { slug }, query: { project_id: anyProjectId } },
					body: { section: "", fields },
				}),
			);
		},
		onSuccess: (_d, fields) => {
			refresh();
			const n = Object.keys(fields).length;
			toast.success(`${n} ${n === 1 ? "key" : "keys"} saved`);
		},
		onError: (e) => toast.error("Couldn't save keys", { description: errorMessage(e) }),
	});

	const deleteKey = useMutation({
		mutationFn: async ({ section, name }: { section: string; name: string }) => {
			if (!anyProjectId) throw new Error("No Project attachment");
			return unwrap(
				await api.DELETE("/api/vault/{slug}/items", {
					params: { path: { slug }, query: { project_id: anyProjectId } },
					body: { section, fields: [name] },
				}),
			);
		},
		onSuccess: () => refresh(),
		onError: (e) => toast.error("Couldn't delete key", { description: errorMessage(e) }),
	});

	const attachProject = useMutation({
		mutationFn: async (projectId: string) => {
			if (!vault) throw new Error("Vault not loaded");
			return unwrap(
				await api.POST("/api/vault", {
					params: { query: { project_id: projectId } },
					body: { slug: vault.slug, name: vault.name },
				}),
			);
		},
		onSuccess: () => {
			refresh();
			toast.success("Vault added to Project");
		},
		onError: (e) => toast.error("Couldn't add vault to Project", { description: errorMessage(e) }),
	});

	const detachProject = useMutation({
		mutationFn: async (projectId: string) =>
			unwrap(
				await api.DELETE("/api/vault/{slug}", {
					params: { path: { slug }, query: { project_id: projectId } },
				}),
			),
		onSuccess: () => {
			refresh();
			toast.success("Vault removed from Project");
		},
		onError: (e) =>
			toast.error("Couldn't remove vault from Project", { description: errorMessage(e) }),
	});

	useSetBreadcrumbTitle(vault?.name ?? null);

	if (vaults.isLoading) {
		return (
			<div className="space-y-5 px-4 lg:px-6">
				<Skeleton className="h-10 w-52" />
				<Skeleton className="h-40 w-full rounded-xl" />
			</div>
		);
	}

	if (!vault) {
		return (
			<div className="space-y-5 px-4 lg:px-6">
				<Button asChild variant="ghost" size="sm" className="w-fit">
					<Link href="/vault">
						<ArrowLeft className="mr-1.5 size-4" />
						Vaults
					</Link>
				</Button>
				<Alert>
					<AlertTitle>Vault not found</AlertTitle>
					<AlertDescription>
						This vault may have been removed, or your account no longer has access.
					</AlertDescription>
				</Alert>
			</div>
		);
	}

	const attachedProjects = (vault.project_ids ?? [])
		.map((id) => projectById.get(id))
		.filter((p): p is ProjectRow => !!p);

	return (
		<div className="space-y-6 px-4 lg:px-6">
			<Button asChild variant="ghost" size="sm" className="w-fit">
				<Link href="/vault">
					<ArrowLeft className="mr-1.5 size-4" />
					Vaults
				</Link>
			</Button>

			<div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
				<div className="flex min-w-0 items-start gap-3">
					<span
						className={cn(
							"flex size-11 shrink-0 select-none items-center justify-center rounded-xl text-2xl leading-none",
							identityFor(vault.name).colorClasses,
						)}
					>
						{identityFor(vault.name).emoji}
					</span>
					<div className="min-w-0">
						<h1 className="truncate text-xl font-semibold tracking-tight">{vault.name}</h1>
						<p className="mt-1 text-sm text-muted-foreground">
							{isOwner
								? "Keys live here once and work in every Project this vault is added to."
								: "Shared with you — your agents can use these keys; only the owner edits them."}
						</p>
						<p className="mt-0.5 font-mono text-xs text-muted-foreground">vault://{vault.slug}</p>
					</div>
				</div>
				{isOwner ? (
					<div className="flex shrink-0 items-center gap-2">
						<ShareKeysDialog
							vault={vault}
							projects={projects.data ?? []}
							onAttach={(projectId) => attachProject.mutateAsync(projectId)}
						/>
						<ConfirmAction
							title={`Delete ${vault.name}?`}
							description={
								<p>
									Every key in this vault is removed for every Project using it. Agents lose access
									immediately.
								</p>
							}
							confirmLabel="Delete vault"
							destructive
							onConfirm={async () => {
								for (const pid of vault.project_ids ?? []) {
									await detachProject.mutateAsync(pid);
								}
								router.push("/vault");
							}}
						>
							<Button variant="outline" size="sm" className="text-destructive">
								<Trash2 className="mr-1.5 size-3.5" />
								Delete
							</Button>
						</ConfirmAction>
					</div>
				) : null}
			</div>

			{/* Keys */}
			<section className="space-y-3">
				<div className="flex items-end justify-between gap-2">
					<div>
						<div className="flex items-center gap-2">
							<h2 className="text-sm font-semibold">Keys</h2>
							{keys.data ? (
								<Badge variant="secondary" className="tabular-nums">
									{keyNames.length}
								</Badge>
							) : null}
						</div>
						<p className="mt-0.5 text-xs text-muted-foreground">
							Values are write-only here — agents read them at runtime through the CLI.
						</p>
					</div>
					{isOwner ? (
						<div className="flex items-center gap-2">
							<Button
								variant="outline"
								size="sm"
								aria-expanded={showAddKey}
								onClick={() => setShowAddKey((v) => !v)}
								disabled={!anyProjectId}
							>
								<Plus className="size-3.5" />
								Add key
							</Button>
							<ImportKeysDialog
								disabled={!anyProjectId}
								isPending={upsertKeys.isPending}
								onImport={(fields) => upsertKeys.mutate(fields)}
							/>
						</div>
					) : null}
				</div>

				{isOwner && showAddKey ? (
					<AddKeyRow
						disabled={!anyProjectId || upsertKeys.isPending}
						onAdd={(name, value) => upsertKeys.mutate({ [name]: value })}
					/>
				) : null}

				{keys.isLoading ? (
					<Skeleton className="h-32 w-full rounded-lg" />
				) : keyNames.length === 0 ? (
					<div className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
						No keys yet. Add one above or paste several at once with Import.
					</div>
				) : (
					<div className="divide-y overflow-hidden rounded-lg border bg-card">
						{keyNames.map(({ section, name }) => (
							<div key={`${section}/${name}`} className="flex items-center gap-3 px-4 py-2.5">
								<span className="min-w-0 flex-1 truncate font-mono text-sm">
									{/* "(default)" is the backend's implicit section — noise, hide it. */}
									{section && section !== "(default)" ? `${section}/` : ""}
									{name}
								</span>
								<span className="font-mono text-xs text-muted-foreground select-none">
									••••••••
								</span>
								{isOwner ? (
									<ConfirmAction
										title={`Delete ${name}?`}
										description={<p>The key is removed for every Project using this vault.</p>}
										confirmLabel="Delete key"
										destructive
										onConfirm={() => deleteKey.mutate({ section, name })}
									>
										<Button
											variant="ghost"
											size="icon-sm"
											className="text-muted-foreground hover:text-destructive"
											aria-label={`Delete ${name}`}
										>
											<Trash2 className="size-3.5" />
										</Button>
									</ConfirmAction>
								) : null}
							</div>
						))}
					</div>
				)}
			</section>

			{/* Projects */}
			<section className="space-y-3">
				<div className="flex items-end justify-between gap-2">
					<div>
						<div className="flex items-center gap-2">
							<h2 className="text-sm font-semibold">Projects</h2>
							<Badge variant="secondary" className="tabular-nums">
								{attachedProjects.length}
							</Badge>
						</div>
						<p className="mt-0.5 text-xs text-muted-foreground">
							Agents bound to these Projects can resolve this vault&apos;s keys at runtime.
						</p>
					</div>
					{isOwner ? (
						<AttachProjectPicker
							projects={(projects.data ?? []).filter(
								(p) => p.is_owner !== false && !(vault.project_ids ?? []).includes(p.id),
							)}
							isPending={attachProject.isPending}
							onAttach={(projectId) => attachProject.mutate(projectId)}
						/>
					) : null}
				</div>
				{attachedProjects.length === 0 ? (
					<div className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
						Not added to any Project yet — agents can&apos;t use these keys until it is.
					</div>
				) : (
					<div className="divide-y overflow-hidden rounded-lg border bg-card">
						{attachedProjects.map((project) => (
							<div key={project.id} className="flex items-center gap-3 px-4 py-2.5">
								<Link
									href={`/projects/${project.id}`}
									className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
								>
									{displayProjectName(project)}
								</Link>
								<span className="font-mono text-xs text-muted-foreground">{project.slug}</span>
								{isOwner && (vault.project_ids?.length ?? 0) > 1 ? (
									<ConfirmAction
										title={`Remove from ${displayProjectName(project)}?`}
										description={<p>Agents using that Project lose access to these keys.</p>}
										confirmLabel="Remove"
										destructive
										onConfirm={() => detachProject.mutate(project.id)}
									>
										<Button
											variant="ghost"
											size="icon-sm"
											className="text-muted-foreground hover:text-destructive"
											aria-label={`Remove from ${displayProjectName(project)}`}
										>
											<Trash2 className="size-3.5" />
										</Button>
									</ConfirmAction>
								) : null}
							</div>
						))}
					</div>
				)}
			</section>
		</div>
	);
}

function AddKeyRow({
	disabled,
	onAdd,
}: {
	disabled: boolean;
	onAdd: (name: string, value: string) => void;
}) {
	const [name, setName] = useState("");
	const [value, setValue] = useState("");
	const normalized = name.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
	const submit = () => {
		if (!normalized || !value) return;
		onAdd(normalized, value);
		setName("");
		setValue("");
	};
	return (
		<div className="flex flex-col gap-2 sm:flex-row">
			<Input
				value={name}
				onChange={(e) => setName(e.target.value)}
				placeholder="OPENAI_API_KEY"
				aria-label="Key name"
				autoComplete="off"
				spellCheck={false}
				className="font-mono sm:max-w-60"
			/>
			<Input
				type="password"
				value={value}
				onChange={(e) => setValue(e.target.value)}
				placeholder="value"
				aria-label="Key value"
				autoComplete="off"
				className="min-w-0 flex-1 font-mono"
				onKeyDown={(e) => {
					if (e.key === "Enter") submit();
				}}
			/>
			<Button onClick={submit} disabled={disabled || !normalized || !value} className="sm:w-auto">
				<Plus className="size-3.5" />
				Add key
			</Button>
		</div>
	);
}

function ImportKeysDialog({
	disabled,
	isPending,
	onImport,
}: {
	disabled: boolean;
	isPending: boolean;
	onImport: (fields: Record<string, string>) => void;
}) {
	const [open, setOpen] = useState(false);
	const [text, setText] = useState("");

	// `KEY=value` lines (dotenv-style). Quotes around values are stripped;
	// comments and blank lines ignored.
	const fields = useMemo(() => {
		const out: Record<string, string> = {};
		for (const rawLine of text.split("\n")) {
			const line = rawLine.trim();
			if (!line || line.startsWith("#")) continue;
			const eq = line.indexOf("=");
			if (eq <= 0) continue;
			const key = line
				.slice(0, eq)
				.trim()
				.replace(/^export\s+/, "")
				.toUpperCase()
				.replace(/[^A-Z0-9_]/g, "_");
			let value = line.slice(eq + 1).trim();
			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			) {
				value = value.slice(1, -1);
			}
			if (key && value) out[key] = value;
		}
		return out;
	}, [text]);
	const count = Object.keys(fields).length;

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) setText("");
			}}
		>
			<DialogTrigger asChild>
				<Button variant="outline" size="sm" disabled={disabled}>
					<ClipboardPaste className="mr-1.5 size-3.5" />
					Import
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Import keys</DialogTitle>
					<DialogDescription>
						Paste <span className="font-mono">KEY=value</span> lines — straight from a .env file
						works.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-3">
					<Textarea
						value={text}
						onChange={(e) => setText(e.target.value)}
						placeholder={"OPENAI_API_KEY=sk-…\nGITHUB_TOKEN=ghp_…"}
						rows={8}
						autoFocus
						spellCheck={false}
						className="resize-none font-mono text-xs"
					/>
					<div className="flex items-center justify-between gap-2">
						<span className="text-xs text-muted-foreground tabular-nums">
							{count} {count === 1 ? "key" : "keys"} detected
						</span>
						<Button
							onClick={() => {
								onImport(fields);
								setOpen(false);
								setText("");
							}}
							disabled={count === 0 || isPending}
						>
							{isPending ? <Spinner /> : <Check className="size-3.5" />}
							Import {count > 0 ? count : ""}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function AttachProjectPicker({
	projects,
	isPending,
	onAttach,
}: {
	projects: ProjectRow[];
	isPending: boolean;
	onAttach: (projectId: string) => void;
}) {
	const [value, setValue] = useState("");
	if (projects.length === 0) return null;
	return (
		<div className="flex items-center gap-2">
			<Select value={value} onValueChange={setValue}>
				<SelectTrigger size="sm" className="w-44" aria-label="Project to add this vault to">
					<SelectValue placeholder="Add to Project…" />
				</SelectTrigger>
				<SelectContent>
					{projects.map((p) => (
						<SelectItem key={p.id} value={p.id}>
							{displayProjectName(p)}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<Button
				size="sm"
				variant="outline"
				disabled={!value || isPending}
				onClick={() => {
					onAttach(value);
					setValue("");
				}}
			>
				{isPending ? <Spinner /> : <Plus className="size-3.5" />}
				Add
			</Button>
		</div>
	);
}

/**
 * The guided share chain (journey J5): keys are shared by putting the vault
 * in a workspace Project and sharing that Project. This sheet walks the two
 * hops in one place instead of leaving users to discover them.
 */
function ShareKeysDialog({
	vault,
	projects,
	onAttach,
}: {
	vault: VaultSummary;
	projects: ProjectRow[];
	onAttach: (projectId: string) => Promise<unknown>;
}) {
	const [open, setOpen] = useState(false);
	const [projectId, setProjectId] = useState("");
	const [attached, setAttached] = useState<ProjectRow | null>(null);
	const [isAttaching, setIsAttaching] = useState(false);

	const shareable = projects.filter((p) => p.is_owner !== false && isCustomProject(p));
	const alreadyIn = shareable.filter((p) => (vault.project_ids ?? []).includes(p.id));
	const candidates = shareable;

	const reset = () => {
		setProjectId("");
		setAttached(null);
		setIsAttaching(false);
	};

	let body: ReactNode;
	if (attached) {
		body = (
			<div className="space-y-4">
				<Alert>
					<Check className="size-4" />
					<AlertTitle>Vault is in {displayProjectName(attached)}</AlertTitle>
					<AlertDescription>
						Now invite your colleague to that Project. They&apos;ll see key names here, and their
						agents can use the values through the CLI — they can never read or edit the values.
					</AlertDescription>
				</Alert>
				<ShareProjectDialog
					projectId={attached.id}
					projectName={displayProjectName(attached)}
					projectKind={attached.kind}
				>
					<Button className="w-full">
						<Share2 className="mr-1.5 size-3.5" />
						Invite people to {displayProjectName(attached)}
					</Button>
				</ShareProjectDialog>
			</div>
		);
	} else if (shareable.length === 0) {
		body = (
			<Alert>
				<AlertTitle>Create a Project first</AlertTitle>
				<AlertDescription>
					Keys are shared through a Project. Create one on the Projects page, then come back here.
				</AlertDescription>
			</Alert>
		);
	} else {
		body = (
			<div className="space-y-4">
				<p className="text-sm text-muted-foreground">
					Keys are shared through a Project: put this vault in one, then invite people to it.
					Members&apos; agents can use the keys; nobody but you can read or edit the values.
				</p>
				<div className="space-y-1.5">
					<Label htmlFor="share-keys-project">Project</Label>
					<Select value={projectId} onValueChange={setProjectId}>
						<SelectTrigger id="share-keys-project" className="w-full">
							<SelectValue placeholder="Choose a Project…" />
						</SelectTrigger>
						<SelectContent>
							{candidates.map((p) => (
								<SelectItem key={p.id} value={p.id}>
									{displayProjectName(p)}
									{(vault.project_ids ?? []).includes(p.id) ? " (already added)" : ""}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<Button
					className="w-full"
					disabled={!projectId || isAttaching}
					onClick={async () => {
						const project = candidates.find((p) => p.id === projectId);
						if (!project) return;
						if ((vault.project_ids ?? []).includes(project.id)) {
							setAttached(project);
							return;
						}
						setIsAttaching(true);
						try {
							await onAttach(project.id);
							setAttached(project);
						} finally {
							setIsAttaching(false);
						}
					}}
				>
					{isAttaching ? <Spinner /> : <Plus className="size-3.5" />}
					{projectId && (vault.project_ids ?? []).includes(projectId)
						? "Continue"
						: "Add vault to Project"}
				</Button>
				{alreadyIn.length > 0 ? (
					<p className="text-xs text-muted-foreground">
						Already in: {alreadyIn.map((p) => displayProjectName(p)).join(", ")}
					</p>
				) : null}
			</div>
		);
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) reset();
			}}
		>
			<DialogTrigger asChild>
				<Button size="sm">
					<Share2 className="mr-1.5 size-3.5" />
					Share keys
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Share keys</DialogTitle>
					<DialogDescription>
						Give a teammate&apos;s agents access to {vault.name}.
					</DialogDescription>
				</DialogHeader>
				{body}
			</DialogContent>
		</Dialog>
	);
}
