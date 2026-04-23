"use client";

import { FEATURED_SKILLS } from "@clawdi-cloud/shared/consts";
import { useAuth } from "@clerk/nextjs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
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
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/api";
import type { SkillSummary } from "@/lib/api-schemas";

export default function SkillsPage() {
	const { getToken } = useAuth();
	const queryClient = useQueryClient();
	const [customRepo, setCustomRepo] = useState("");
	const [installing, setInstalling] = useState<string | null>(null);
	const [installError, setInstallError] = useState<string | null>(null);

	const { data: skills, isLoading } = useQuery({
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
	});

	const installSkill = async (repo: string, path?: string) => {
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
		} catch (e: unknown) {
			setInstallError(e instanceof Error ? e.message : String(e));
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
		await installSkill(repo, path);
		if (!installError) setCustomRepo("");
	};

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

			{/* My Skills */}
			<section>
				<h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
					Installed
				</h2>
				{isLoading ? (
					<div className="grid grid-cols-1 gap-2 md:grid-cols-2">
						{Array.from({ length: 4 }).map((_, i) => (
							<div key={i} className="rounded-lg border bg-card p-4 space-y-2">
								<Skeleton className="h-4 w-32" />
								<Skeleton className="h-3 w-48" />
								<Skeleton className="h-3 w-24" />
							</div>
						))}
					</div>
				) : skills?.length ? (
					<div className="grid grid-cols-1 gap-2 md:grid-cols-2">
						{skills.map((s) => (
							<div
								key={s.id}
								className="group flex items-start justify-between rounded-lg border bg-card p-4"
							>
								<div className="min-w-0">
									<div className="flex items-center gap-2">
										<Sparkles className="size-3.5 text-primary shrink-0" />
										<span className="font-medium text-sm">{s.skill_key}</span>
										<span className="text-[10px] rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
											v{s.version}
										</span>
										{s.file_count ? (
											<span className="text-[10px] text-muted-foreground">
												{s.file_count} file{s.file_count === 1 ? "" : "s"}
											</span>
										) : null}
									</div>
									{s.description && (
										<p className="text-xs text-muted-foreground mt-1 line-clamp-2">
											{s.description}
										</p>
									)}
									<div className="text-[10px] text-muted-foreground mt-1.5">
										{s.source}
										{s.source_repo && <span> · {s.source_repo}</span>}
									</div>
								</div>
								<Button
									variant="ghost"
									size="icon-sm"
									onClick={() => deleteSkill.mutate(s.skill_key)}
									disabled={deleteSkill.isPending}
									className="text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive shrink-0"
								>
									<Trash2 className="size-3.5" />
								</Button>
							</div>
						))}
					</div>
				) : (
					<EmptyState
						description={
							<>
								No skills installed yet. Install from below or run{" "}
								<code className="bg-muted px-1.5 py-0.5 rounded text-xs">
									clawdi skill install owner/repo
								</code>
							</>
						}
					/>
				)}
			</section>

			{/* Marketplace */}
			<section>
				<div className="flex items-center justify-between mb-3">
					<h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
						Marketplace
					</h2>
					<a
						href="https://skills.sh"
						target="_blank"
						rel="noopener noreferrer"
						className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5 transition-colors"
					>
						skills.sh <ExternalLink className="size-3" />
					</a>
				</div>

				{/* Custom install */}
				<div className="flex gap-2 mb-3">
					<div className="relative flex-1">
						<Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground z-10" />
						<Input
							value={customRepo}
							onChange={(e) => {
								setCustomRepo(e.target.value);
								setInstallError(null);
							}}
							placeholder="Install from GitHub: owner/repo/path..."
							className="rounded-xl pl-9"
							onKeyDown={(e) => {
								if (e.key === "Enter") handleCustomInstall();
							}}
						/>
					</div>
					<Button
						onClick={handleCustomInstall}
						disabled={!customRepo.trim() || !!installing}
						className="rounded-lg"
					>
						{installing && customRepo ? (
							<Loader2 className="size-4 animate-spin" />
						) : (
							<Plus className="size-4" />
						)}
						Install
					</Button>
				</div>
				{installError && <p className="text-xs text-destructive mb-3">{installError}</p>}

				{/* Featured skills */}
				<div className="grid grid-cols-1 gap-2 md:grid-cols-2">
					{FEATURED_SKILLS.map((skill) => {
						const key = `${skill.repo}/${skill.path || ""}`;
						const skillKey = skill.name.toLowerCase().replace(/\s+/g, "-");
						const isInstalled = installedKeys.has(skillKey);
						const isInstalling = installing === key;
						return (
							<div
								key={key}
								className="flex items-start justify-between rounded-lg border bg-card p-4"
							>
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<Sparkles className="size-3.5 text-primary shrink-0" />
										<span className="font-medium text-sm">{skill.name}</span>
										<Badge variant="secondary" className="text-[10px]">
											{skill.installs}
										</Badge>
									</div>
									<p className="text-xs text-muted-foreground mt-1 line-clamp-2">
										{skill.description}
									</p>
									<div className="text-[10px] text-muted-foreground mt-1.5">
										{skill.repo}
										{skill.path ? `/${skill.path}` : ""}
									</div>
								</div>
								{isInstalled ? (
									<span className="inline-flex items-center gap-1 text-[10px] text-green-600 dark:text-green-400 px-2 py-1 shrink-0 ml-3">
										<Check className="size-3" />
										Installed
									</span>
								) : (
									<Button
										variant="outline"
										size="sm"
										onClick={() => installSkill(skill.repo, skill.path)}
										disabled={isInstalling}
										className="shrink-0 ml-3 text-xs"
									>
										{isInstalling ? (
											<Loader2 className="size-3 animate-spin" />
										) : (
											<Download className="size-3" />
										)}
										Install
									</Button>
								)}
							</div>
						);
					})}
				</div>
			</section>
		</div>
	);
}
