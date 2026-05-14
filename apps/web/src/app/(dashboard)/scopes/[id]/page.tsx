"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	ArrowLeft,
	ExternalLink,
	KeyRound,
	LogOut,
	type LucideIcon,
	Plus,
	Share2,
	Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { ShareScopeDialog } from "@/components/sharing/share-scope-dialog";
import { formatApiError } from "@/components/sharing/vault-conflicts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { ApiError, unwrap, useApi, useAuthedFetch } from "@/lib/api";
import type { components } from "@/lib/api-schemas";
import { errorMessage } from "@/lib/utils";

type SkillSummary = components["schemas"]["SkillSummaryResponse"];
type VaultSummary = components["schemas"]["VaultResponse"];

interface ScopeRow {
	id: string;
	name: string;
	slug: string;
	kind: string;
	origin_environment_id: string | null;
	archived_at: string | null;
	created_at: string;
	is_owner?: boolean;
}

export default function ScopeDetailPage() {
	const params = useParams<{ id: string }>();
	const scopeId = params.id;
	const api = useApi();
	const authedFetch = useAuthedFetch();
	const qc = useQueryClient();
	const router = useRouter();

	const scopes = useQuery({
		queryKey: ["scopes"],
		queryFn: async (): Promise<ScopeRow[]> => {
			const r = await authedFetch("/api/projects");
			return r.json();
		},
	});

	const rows = scopes.data ?? [];
	const scope = rows.find((s) => s.id === scopeId) ?? null;
	const isOwner = scope?.is_owner !== false;

	const skills = useQuery({
		queryKey: ["skills", "project-detail", scopeId],
		queryFn: async () =>
			unwrap(
				await api.GET("/api/skills", {
					params: { query: { scope_id: scopeId, page_size: 100 } },
				}),
			),
		enabled: !!scope,
	});

	const vaults = useQuery({
		queryKey: ["vaults", "project-detail", scopeId],
		queryFn: async () =>
			unwrap(
				await api.GET("/api/vault", {
					params: { query: { scope_id: scopeId, page_size: 100 } },
				}),
			),
		enabled: !!scope,
	});

	const refresh = () => {
		qc.invalidateQueries({ queryKey: ["scopes"] });
		qc.invalidateQueries({ queryKey: ["skills"] });
		qc.invalidateQueries({ queryKey: ["vaults"] });
	};

	const leaveSharedScope = useMutation({
		mutationFn: async (): Promise<{ status: string }> => {
			const r = await authedFetch(`/api/projects/${scopeId}/leave`, { method: "POST" });
			return r.json();
		},
		onSuccess: () => {
			refresh();
			toast.success("Left shared project", { description: "Membership removed." });
			router.push("/scopes");
		},
		onError: (e) => {
			toast.error("Failed to leave shared project", {
				description: e instanceof ApiError ? formatApiError(e.detail) : errorMessage(e),
			});
		},
	});

	if (scopes.isLoading) {
		return (
			<div className="space-y-5 px-4 lg:px-6">
				<Skeleton className="h-10 w-52" />
				<Skeleton className="h-28 w-full" />
				<Skeleton className="h-48 w-full" />
			</div>
		);
	}

	if (scopes.error) {
		return (
			<div className="space-y-5 px-4 lg:px-6">
				<Button asChild variant="ghost" size="sm" className="w-fit">
					<Link href="/scopes">
						<ArrowLeft className="mr-1.5 size-4" />
						Projects
					</Link>
				</Button>
				<Alert variant="destructive">
					<AlertTitle>Couldn&apos;t load project</AlertTitle>
					<AlertDescription>{errorMessage(scopes.error)}</AlertDescription>
				</Alert>
			</div>
		);
	}

	if (!scope) {
		return (
			<div className="space-y-5 px-4 lg:px-6">
				<Button asChild variant="ghost" size="sm" className="w-fit">
					<Link href="/scopes">
						<ArrowLeft className="mr-1.5 size-4" />
						Projects
					</Link>
				</Button>
				<Alert>
					<AlertTitle>Project not found</AlertTitle>
					<AlertDescription>
						This project may have been removed, or your account no longer has access.
					</AlertDescription>
				</Alert>
			</div>
		);
	}

	return (
		<div className="space-y-5 px-4 lg:px-6">
			<Button asChild variant="ghost" size="sm" className="w-fit">
				<Link href="/scopes">
					<ArrowLeft className="mr-1.5 size-4" />
					Projects
				</Link>
			</Button>

			<PageHeader
				title={displayScopeName(scope)}
				description={`${isOwner ? "Owned" : "Shared viewer"} · ${scopeKindMeta(scope.kind).label} · ${scope.slug}`}
				actions={
					<div className="flex items-center gap-2">
						<ScopeKindBadge kind={scope.kind} />
						{isOwner ? (
							<ShareScopeDialog
								scopeId={scope.id}
								scopeName={displayScopeName(scope)}
								scopeKind={scope.kind}
							>
								<Button variant="outline" size="sm">
									<Share2 className="mr-1.5 size-3.5" />
									Share
								</Button>
							</ShareScopeDialog>
						) : null}
					</div>
				}
			/>

			<ScopeStatsStrip
				skillCount={skills.data?.items.length ?? 0}
				vaultCount={vaults.data?.items.length ?? 0}
			/>

			<div className={isOwner ? "space-y-6" : "grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]"}>
				<div className="space-y-6">
					<section className="space-y-3">
						<ContentHeader title="Skills" />
						{isOwner ? <InstallSkillInScopeForm scopeId={scope.id} onChanged={refresh} /> : null}
						{skills.isLoading ? (
							<Skeleton className="h-24 w-full" />
						) : skills.error ? (
							<ErrorLine message={errorMessage(skills.error)} />
						) : skills.data?.items.length ? (
							<div className="divide-y rounded-lg border">
								{skills.data.items.map((skill) => (
									<SkillRow
										key={`${skill.scope_id}:${skill.skill_key}`}
										skill={skill}
										ownScopeId={scope.id}
									/>
								))}
							</div>
						) : (
							<EmptyLine message="No skills are visible in this project yet." />
						)}
					</section>

					<section className="space-y-3">
						<ContentHeader title="Vaults" />
						{isOwner ? <CreateVaultInScopeForm scopeId={scope.id} onChanged={refresh} /> : null}
						{vaults.isLoading ? (
							<Skeleton className="h-24 w-full" />
						) : vaults.error ? (
							<ErrorLine message={errorMessage(vaults.error)} />
						) : vaults.data?.items.length ? (
							<div className="divide-y rounded-lg border">
								{vaults.data.items.map((vault) => (
									<VaultRow key={vault.id} vault={vault} ownScopeId={scope.id} />
								))}
							</div>
						) : (
							<EmptyLine message="No vault references are visible in this project yet." />
						)}
					</section>
				</div>

				{!isOwner ? (
					<aside className="space-y-4">
						<section className="space-y-3 rounded-lg border p-3">
							<div className="space-y-1">
								<h2 className="text-sm font-semibold">Project Access Granted</h2>
								<p className="text-xs text-muted-foreground">
									You can read this shared project. Bind it to one or more agents from the agents
									page when you want runtime access.
								</p>
							</div>
							<AlertDialog>
								<AlertDialogTrigger asChild>
									<Button
										variant="ghost"
										size="sm"
										disabled={leaveSharedScope.isPending}
										className="w-fit text-muted-foreground hover:text-destructive"
									>
										<LogOut className="mr-1.5 size-3.5" />
										{leaveSharedScope.isPending ? "Leaving..." : "Leave project"}
									</Button>
								</AlertDialogTrigger>
								<AlertDialogContent>
									<AlertDialogHeader>
										<AlertDialogTitle>Leave "{displayScopeName(scope)}"?</AlertDialogTitle>
										<AlertDialogDescription>
											This removes your read membership from the shared project.
										</AlertDialogDescription>
									</AlertDialogHeader>
									<AlertDialogFooter>
										<AlertDialogCancel>Cancel</AlertDialogCancel>
										<AlertDialogAction
											onClick={() => leaveSharedScope.mutate()}
											className="bg-destructive text-white hover:bg-destructive/90"
										>
											Leave project
										</AlertDialogAction>
									</AlertDialogFooter>
								</AlertDialogContent>
							</AlertDialog>
						</section>
					</aside>
				) : null}
			</div>
		</div>
	);
}

function ScopeStatsStrip({ skillCount, vaultCount }: { skillCount: number; vaultCount: number }) {
	return (
		<div className="grid divide-y rounded-lg border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
			<StatCell icon={Sparkles} label="Skills" value={skillCount} />
			<StatCell icon={KeyRound} label="Vaults" value={vaultCount} />
		</div>
	);
}

function StatCell({
	icon: Icon,
	label,
	value,
}: {
	icon: LucideIcon;
	label: string;
	value: number;
}) {
	return (
		<div className="flex items-center justify-between gap-3 px-4 py-3">
			<div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
				<Icon className="size-4 shrink-0" />
				<span className="truncate">{label}</span>
			</div>
			<div className="text-xl font-semibold">{value}</div>
		</div>
	);
}

function ContentHeader({ title }: { title: string }) {
	return (
		<div className="flex items-center justify-between gap-3">
			<h2 className="text-base font-semibold">{title}</h2>
		</div>
	);
}

function InstallSkillInScopeForm({
	scopeId,
	onChanged,
}: {
	scopeId: string;
	onChanged: () => void;
}) {
	const api = useApi();
	const [repoInput, setRepoInput] = useState("");
	const [error, setError] = useState<string | null>(null);
	const install = useMutation({
		mutationFn: async ({ repo, path }: { repo: string; path?: string }) =>
			unwrap(
				await api.POST("/api/scopes/{scope_id}/skills/install", {
					params: { path: { scope_id: scopeId } },
					body: { repo, path },
				}),
			),
		onSuccess: () => {
			setRepoInput("");
			setError(null);
			onChanged();
			toast.success("Skill installed in this project");
		},
		onError: (e) => {
			setError(errorMessage(e));
		},
	});

	const submit = () => {
		setError(null);
		const trimmed = repoInput.trim();
		if (!trimmed) return;
		const clean = trimmed.replace(/^https?:\/\/github\.com\//, "").replace(/\/$/, "");
		const parts = clean.split("/").filter(Boolean);
		if (parts.length < 2) {
			setError("Enter as `owner/repo` or `owner/repo/path-to-skill`.");
			return;
		}
		install.mutate({
			repo: `${parts[0]}/${parts[1]}`,
			path: parts.length > 2 ? parts.slice(2).join("/") : undefined,
		});
	};

	return (
		<div className="flex max-w-3xl flex-col gap-2 rounded-lg border bg-muted/20 p-3 sm:flex-row sm:flex-wrap sm:items-center">
			<Input
				value={repoInput}
				onChange={(e) => {
					setRepoInput(e.target.value);
					setError(null);
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter") submit();
				}}
				placeholder="Install skill from GitHub: owner/repo or owner/repo/path"
				aria-invalid={!!error || undefined}
				className="min-w-0 flex-1"
			/>
			<Button
				size="sm"
				disabled={!repoInput.trim() || install.isPending}
				onClick={submit}
				className="w-full sm:w-auto"
			>
				{install.isPending ? <Spinner /> : <Plus className="mr-1.5 size-3.5" />}
				Install skill
			</Button>
			{error ? <p className="text-xs text-destructive sm:basis-full">{error}</p> : null}
		</div>
	);
}

function CreateVaultInScopeForm({
	scopeId,
	onChanged,
}: {
	scopeId: string;
	onChanged: () => void;
}) {
	const api = useApi();
	const [slug, setSlug] = useState("");
	const create = useMutation({
		mutationFn: async (nextSlug: string) =>
			unwrap(
				await api.POST("/api/vault", {
					params: { query: { scope_id: scopeId } },
					body: { slug: nextSlug, name: nextSlug },
				}),
			),
		onSuccess: () => {
			setSlug("");
			onChanged();
			toast.success("Vault created in this project");
		},
		onError: (e) => toast.error("Failed to create vault", { description: errorMessage(e) }),
	});

	return (
		<div className="flex max-w-3xl flex-col gap-2 rounded-lg border bg-muted/20 p-3 sm:flex-row sm:items-center">
			<Input
				value={slug}
				onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
				onKeyDown={(e) => {
					if (e.key === "Enter" && slug) create.mutate(slug);
				}}
				placeholder="New vault name for this project"
				className="min-w-0 flex-1"
			/>
			<Button
				size="sm"
				disabled={!slug || create.isPending}
				onClick={() => slug && create.mutate(slug)}
				className="w-full sm:w-auto"
			>
				{create.isPending ? <Spinner /> : <Plus className="mr-1.5 size-3.5" />}
				Create vault
			</Button>
		</div>
	);
}

function SkillRow({ skill, ownScopeId }: { skill: SkillSummary; ownScopeId: string }) {
	const direct = skill.scope_id === ownScopeId;
	return (
		<div className="flex items-center justify-between gap-3 p-3">
			<div className="min-w-0">
				<div className="flex items-center gap-2">
					<span className="truncate text-sm font-medium">{skill.name}</span>
					<Badge variant={direct ? "secondary" : "outline"}>{direct ? "direct" : "linked"}</Badge>
				</div>
				<div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
					{skill.skill_key}
				</div>
			</div>
			<Button asChild variant="ghost" size="icon-sm">
				<Link
					href={`/skills/${encodeURIComponent(skill.skill_key)}?scope=${encodeURIComponent(skill.scope_id ?? ownScopeId)}`}
					aria-label={`Open ${skill.name}`}
				>
					<ExternalLink className="size-3.5" />
				</Link>
			</Button>
		</div>
	);
}

function VaultRow({ vault, ownScopeId }: { vault: VaultSummary; ownScopeId: string }) {
	const direct = vault.scope_id === ownScopeId;
	return (
		<div className="flex items-center justify-between gap-3 p-3">
			<div className="min-w-0">
				<div className="flex items-center gap-2">
					<span className="truncate text-sm font-medium">{vault.name}</span>
					<Badge variant={direct ? "secondary" : "outline"}>{direct ? "direct" : "linked"}</Badge>
				</div>
				<div className="mt-0.5 font-mono text-xs text-muted-foreground">{vault.slug}</div>
			</div>
			<Button asChild variant="ghost" size="icon-sm">
				<Link href="/vault" aria-label="Open vault page">
					<ExternalLink className="size-3.5" />
				</Link>
			</Button>
		</div>
	);
}

function ScopeKindBadge({ kind }: { kind: string }) {
	const meta = scopeKindMeta(kind);
	return (
		<Badge
			variant={kind === "personal" ? "outline" : "secondary"}
			className="text-xs"
			title={meta.description}
		>
			{meta.label}
		</Badge>
	);
}

function scopeKindMeta(kind: string) {
	if (kind === "workspace") {
		return {
			label: "Project",
			description: "Reusable context for a project, team, or workflow.",
		};
	}
	if (kind === "environment") {
		return {
			label: "Environment",
			description: "Project created by an agent environment.",
		};
	}
	if (kind === "personal") {
		return {
			label: "Personal",
			description: "Personal default project.",
		};
	}
	return { label: kind, description: `Project type: ${kind}` };
}

function displayScopeName(scope: ScopeRow) {
	if (
		scope.kind === "personal" &&
		(scope.slug === "personal" || ["default", "personal"].includes(scope.name.toLowerCase()))
	) {
		return "Personal";
	}
	return scope.name;
}

function EmptyLine({ message }: { message: string }) {
	return (
		<div className="rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
			{message}
		</div>
	);
}

function ErrorLine({ message }: { message: string }) {
	return (
		<div className="rounded-lg border border-dashed border-destructive/40 px-4 py-4 text-sm text-destructive">
			{message}
		</div>
	);
}
