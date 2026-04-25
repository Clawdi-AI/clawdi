"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ExternalLink, Trash2 } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { useSetBreadcrumbTitle } from "@/components/breadcrumb-title";
import { Markdown } from "@/components/markdown";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
					<Card>
						<CardHeader>
							<CardTitle className="truncate font-semibold text-lg tracking-tight">
								{skill.name}
							</CardTitle>
							<div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
								<Badge variant="secondary">v{skill.version}</Badge>
								<span>{skill.file_count} files</span>
								<span>·</span>
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
							</div>
							{skill.description ? (
								<p className="mt-2 text-sm text-muted-foreground">{skill.description}</p>
							) : null}
						</CardHeader>
					</Card>

					{skill.content ? (
						<Card>
							<CardHeader>
								<CardTitle className="text-base">SKILL.md</CardTitle>
							</CardHeader>
							<CardContent>
								<div className="prose prose-sm max-w-none dark:prose-invert">
									<Markdown content={skill.content} />
								</div>
							</CardContent>
						</Card>
					) : null}

					<Card>
						<CardContent className="py-4">
							<dl className="grid gap-3 text-sm sm:grid-cols-2">
								<div>
									<dt className="text-xs text-muted-foreground">Installed</dt>
									<dd>{skill.created_at ? relativeTime(skill.created_at) : "—"}</dd>
								</div>
								<div>
									<dt className="text-xs text-muted-foreground">Key</dt>
									<dd className="font-mono text-xs">{skill.skill_key}</dd>
								</div>
							</dl>
						</CardContent>
					</Card>
				</>
			) : null}
		</div>
	);
}
