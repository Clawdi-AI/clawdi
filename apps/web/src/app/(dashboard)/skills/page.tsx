"use client";

import { FEATURED_SKILLS } from "@clawdi-cloud/shared/consts";
import { useAuth } from "@clerk/nextjs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	AlertCircle,
	Check,
	Download,
	ExternalLink,
	Loader2,
	Plus,
	Search,
	Sparkles,
	Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/api";
import type { SkillSummary } from "@/lib/api-schemas";
import { errorMessage } from "@/lib/utils";

export default function SkillsPage() {
	const { getToken } = useAuth();
	const queryClient = useQueryClient();
	const [customRepo, setCustomRepo] = useState("");
	const [installing, setInstalling] = useState<string | null>(null);
	const [installError, setInstallError] = useState<string | null>(null);

	const {
		data: skills,
		isLoading,
		error,
	} = useQuery({
		queryKey: ["skills"],
		queryFn: async () => {
			const token = await getToken();
			if (!token) throw new Error("Not authenticated");
			return apiFetch<SkillSummary[]>("/api/skills", token);
		},
	});

	const deleteSkill = useMutation({
		mutationFn: async (key: string) => {
			const token = await getToken();
			if (!token) throw new Error("Not authenticated");
			return apiFetch<unknown>(`/api/skills/${key}`, token, { method: "DELETE" });
		},
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["skills"] }),
		onError: (e) => toast.error("Failed to uninstall skill", { description: errorMessage(e) }),
	});

	const installSkill = async (repo: string, path?: string): Promise<boolean> => {
		const key = `${repo}/${path || ""}`;
		setInstalling(key);
		setInstallError(null);
		try {
			const token = await getToken();
			if (!token) throw new Error("Not authenticated");
			await apiFetch("/api/skills/install", token, {
				method: "POST",
				body: JSON.stringify({ repo, path }),
			});
			queryClient.invalidateQueries({ queryKey: ["skills"] });
			return true;
		} catch (e: unknown) {
			setInstallError(errorMessage(e));
			return false;
		} finally {
			setInstalling(null);
		}
	};

	const handleCustomInstall = async () => {
		if (!customRepo.trim()) return;
		const clean = customRepo.replace(/^https?:\/\/github\.com\//, "").replace(/\/$/, "");
		const parts = clean.split("/");
		if (parts.length < 2) return;
		const repo = `${parts[0]}/${parts[1]}`;
		const path = parts.length > 2 ? parts.slice(2).join("/") : undefined;
		const ok = await installSkill(repo, path);
		if (ok) setCustomRepo("");
	};

	// Match marketplace entries against installed skills by their declared
	// `skillKey` (which is what the backend stores as `skill_key` after install).
	// Slugifying the display name is unreliable — it can drift from the
	// SKILL.md frontmatter that the backend actually uses.
	const installedKeys = new Set(skills?.map((s) => s.skill_key) ?? []);

	return (
		<div className="space-y-6 px-4 lg:px-6">
			<PageHeader
				title="Skills"
				description="Agent instructions synced across your machines."
				actions={
					skills ? (
						<Badge variant="secondary">
							{skills.length} skill{skills.length === 1 ? "" : "s"}
						</Badge>
					) : null
				}
			/>

			<section className="space-y-3">
				<h2 className="text-sm font-semibold text-muted-foreground">Installed</h2>
				{error ? (
					<Alert variant="destructive">
						<AlertCircle />
						<AlertTitle>Failed to load skills</AlertTitle>
						<AlertDescription>{errorMessage(error)}</AlertDescription>
					</Alert>
				) : isLoading ? (
					<div className="grid grid-cols-1 gap-3 md:grid-cols-2">
						{Array.from({ length: 4 }).map((_, i) => (
							<Card key={i}>
								<CardContent className="space-y-2">
									<Skeleton className="h-4 w-32" />
									<Skeleton className="h-4 w-48" />
									<Skeleton className="h-4 w-24" />
								</CardContent>
							</Card>
						))}
					</div>
				) : skills?.length ? (
					<div className="grid grid-cols-1 gap-3 md:grid-cols-2">
						{skills.map((s) => (
							<Card key={s.id} className="group">
								<CardContent className="flex items-start justify-between gap-3">
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2">
											<Sparkles className="size-4 shrink-0 text-primary" />
											<span className="truncate text-sm font-medium">{s.skill_key}</span>
											<Badge variant="outline">v{s.version}</Badge>
											{s.file_count ? (
												<span className="text-xs text-muted-foreground">
													{s.file_count} file{s.file_count === 1 ? "" : "s"}
												</span>
											) : null}
										</div>
										{s.description ? (
											<p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
												{s.description}
											</p>
										) : null}
										<p className="mt-2 text-xs text-muted-foreground">
											{s.source}
											{s.source_repo ? ` · ${s.source_repo}` : ""}
										</p>
									</div>
									<Button
										variant="ghost"
										size="icon-sm"
										onClick={() => deleteSkill.mutate(s.skill_key)}
										disabled={deleteSkill.isPending}
										className="shrink-0 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
										aria-label="Uninstall skill"
									>
										<Trash2 className="size-4" />
									</Button>
								</CardContent>
							</Card>
						))}
					</div>
				) : (
					<EmptyState
						description={
							<>
								No skills installed yet. Install from below or run{" "}
								<code className="rounded bg-muted px-1.5 py-0.5 text-xs">
									clawdi skill install owner/repo
								</code>
							</>
						}
					/>
				)}
			</section>

			<section className="space-y-3">
				<div className="flex items-center justify-between">
					<h2 className="text-sm font-semibold text-muted-foreground">Marketplace</h2>
					<a
						href="https://skills.sh"
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
					>
						skills.sh <ExternalLink className="size-3" />
					</a>
				</div>

				<div className="flex gap-2">
					<div className="relative flex-1">
						<Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
						<Input
							value={customRepo}
							onChange={(e) => {
								setCustomRepo(e.target.value);
								setInstallError(null);
							}}
							placeholder="Install from GitHub: owner/repo/path..."
							className="pl-9"
							onKeyDown={(e) => {
								if (e.key === "Enter") handleCustomInstall();
							}}
						/>
					</div>
					<Button onClick={handleCustomInstall} disabled={!customRepo.trim() || !!installing}>
						{installing && customRepo ? <Loader2 className="animate-spin" /> : <Plus />}
						Install
					</Button>
				</div>
				{installError ? (
					<Alert variant="destructive">
						<AlertCircle />
						<AlertTitle>Install failed</AlertTitle>
						<AlertDescription>{installError}</AlertDescription>
					</Alert>
				) : null}

				<div className="grid grid-cols-1 gap-3 md:grid-cols-2">
					{FEATURED_SKILLS.map((skill) => {
						const key = `${skill.repo}/${skill.path || ""}`;
						const isInstalled = installedKeys.has(skill.skillKey);
						const isInstalling = installing === key;
						return (
							<Card key={key}>
								<CardContent className="flex items-start justify-between gap-3">
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2">
											<Sparkles className="size-4 shrink-0 text-primary" />
											<span className="truncate text-sm font-medium">{skill.name}</span>
										</div>
										<p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
											{skill.description}
										</p>
										<p className="mt-2 text-xs text-muted-foreground">
											{skill.repo}
											{skill.path ? `/${skill.path}` : ""}
										</p>
									</div>
									{isInstalled ? (
										<Badge variant="secondary" className="shrink-0">
											<Check />
											Installed
										</Badge>
									) : (
										<Button
											variant="outline"
											size="sm"
											onClick={() => installSkill(skill.repo, skill.path)}
											disabled={isInstalling}
											className="shrink-0"
										>
											{isInstalling ? <Loader2 className="animate-spin" /> : <Download />}
											Install
										</Button>
									)}
								</CardContent>
							</Card>
						);
					})}
				</div>
			</section>
		</div>
	);
}
