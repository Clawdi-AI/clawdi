"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ExternalLink, FileText, Tag, Trash2 } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { useSetBreadcrumbTitle } from "@/components/breadcrumb-title";
import { Markdown } from "@/components/markdown";
import { Stat } from "@/components/meta/stat";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { unwrap, useApi } from "@/lib/api";
import { errorMessage, relativeTime } from "@/lib/utils";

export default function SkillDetailPage() {
	const { key } = useParams<{ key: string }>();
	const router = useRouter();
	const api = useApi();
	const queryClient = useQueryClient();

	const {
		data: skill,
		isLoading,
		error,
	} = useQuery({
		queryKey: ["skill", key],
		queryFn: async () =>
			unwrap(await api.GET("/api/skills/{skill_key}", { params: { path: { skill_key: key } } })),
	});

	useSetBreadcrumbTitle(skill?.name || (skill ? key : null));

	const uninstall = useMutation({
		mutationFn: async () =>
			unwrap(await api.DELETE("/api/skills/{skill_key}", { params: { path: { skill_key: key } } })),
		onSuccess: () => {
			toast.success("Skill uninstalled");
			queryClient.invalidateQueries({ queryKey: ["skills"] });
			router.push("/skills");
		},
		onError: (e) => toast.error("Failed to uninstall", { description: errorMessage(e) }),
	});

	return (
		<div className="space-y-5 px-4 lg:px-6">
			{skill && !isLoading ? (
				<div className="flex items-center justify-end gap-2">
					<Button
						variant="outline"
						size="sm"
						onClick={() => uninstall.mutate()}
						disabled={uninstall.isPending}
						className="text-destructive hover:text-destructive"
					>
						<Trash2 />
						Uninstall
					</Button>
				</div>
			) : null}

			{error ? (
				<Alert variant="destructive">
					<AlertCircle />
					<AlertTitle>Skill not found</AlertTitle>
					<AlertDescription>{errorMessage(error)}</AlertDescription>
				</Alert>
			) : isLoading ? (
				<Card>
					<CardContent className="space-y-3 py-6">
						<Skeleton className="h-6 w-48" />
						<Skeleton className="h-4 w-64" />
					</CardContent>
				</Card>
			) : skill ? (
				<>
					{/* Flat header — matches sessions/[id] hierarchy.
					    h1 = name, identity row = source/repo/installed,
					    stats row = version + file count. No card wrapping a
					    single entity's metadata; cards earn their existence. */}
					<div className="space-y-2">
						<h1 className="truncate font-semibold text-lg tracking-tight">{skill.name}</h1>
						<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
							<span>{skill.source}</span>
							{skill.source_repo ? (
								<>
									<span>·</span>
									<a
										href={`https://github.com/${skill.source_repo}`}
										target="_blank"
										rel="noreferrer"
										className="inline-flex items-center gap-1 hover:text-foreground"
									>
										{skill.source_repo}
										<ExternalLink className="size-3" />
									</a>
								</>
							) : null}
							{skill.created_at ? (
								<>
									<span>·</span>
									<span>installed {relativeTime(skill.created_at)}</span>
								</>
							) : null}
						</div>
					</div>

					<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
						<Stat icon={Tag} label={`v${skill.version}`} />
						<Stat
							icon={FileText}
							label={`${skill.file_count} file${skill.file_count === 1 ? "" : "s"}`}
						/>
					</div>

					{skill.description ? (
						<p className="text-sm text-muted-foreground">{skill.description}</p>
					) : null}

					{skill.content ? (
						<>
							<Separator />
							<div className="prose prose-sm max-w-none dark:prose-invert">
								<Markdown content={skill.content} />
							</div>
						</>
					) : null}
				</>
			) : null}
		</div>
	);
}
