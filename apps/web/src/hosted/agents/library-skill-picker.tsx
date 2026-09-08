"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { fetchAgentProjectSkills } from "@/components/dashboard/agent-skill-inventory";
import { ProjectCompactPicker } from "@/components/projects/project-metadata";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { unwrap, useApi, useOpenApi } from "@/lib/api";
import type { components } from "@/lib/api-schemas";

type Skill = components["schemas"]["SkillSummaryResponse"];

export function LibrarySkillPicker({
	value,
	onChange,
	disabled = false,
}: {
	value: Skill | null;
	onChange: (skill: Skill | null) => void;
	disabled?: boolean;
}) {
	const api = useApi();
	const projects = useOpenApi().useQuery("get", "/v1/projects");
	const [projectId, setProjectId] = useState("");
	const libraryProjects = (projects.data ?? []).filter((project) => project.kind === "workspace");
	const selectedProject = libraryProjects.find((project) => project.id === projectId);
	const skills = useQuery({
		queryKey: ["skills", "library-picker", projectId],
		queryFn: async () => {
			const rows = await fetchAgentProjectSkills([projectId], async (id, page, pageSize) =>
				unwrap(
					await api.GET("/v1/skills", {
						params: { query: { project_id: id, page, page_size: pageSize } },
					}),
				),
			);
			return rows.filter((skill) => skill.authority === "cloud");
		},
		enabled: Boolean(selectedProject),
	});
	useEffect(() => {
		if (!value) return;
		if (projects.data && !projects.error && !selectedProject) onChange(null);
		else if (skills.data && !skills.error && !skills.data.some((skill) => skill.id === value.id))
			onChange(null);
	}, [onChange, projects.data, projects.error, selectedProject, skills.data, skills.error, value]);
	return (
		<div data-hosted="true" className="space-y-4">
			<div className="space-y-2">
				<Label>Project</Label>
				<ProjectCompactPicker
					projects={libraryProjects}
					value={projectId}
					ariaLabel="Library Project"
					placeholder="Choose a Project"
					disabled={disabled || projects.isLoading}
					onValueChange={(id) => {
						setProjectId(id);
						onChange(null);
					}}
				/>
			</div>
			{projects.error ? (
				<ApiErrorPanel
					error={projects.error}
					onRetry={() => void projects.refetch()}
					title="Couldn't load Library Projects"
				/>
			) : null}
			{selectedProject ? (
				<div className="space-y-2">
					<Label>Skill</Label>
					<Select
						items={(skills.data ?? []).map((skill) => ({ value: skill.id, label: skill.name }))}
						value={value?.id ?? ""}
						disabled={disabled || skills.isLoading || Boolean(skills.error)}
						onValueChange={(id) => onChange(skills.data?.find((skill) => skill.id === id) ?? null)}
					>
						<SelectTrigger className="w-full" aria-label="Library Skill">
							<SelectValue placeholder="Choose a Skill" />
						</SelectTrigger>
						<SelectContent>
							{(skills.data ?? []).map((skill) => (
								<SelectItem key={skill.id} value={skill.id}>
									{skill.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{!skills.isLoading && !skills.error && skills.data?.length === 0 ? (
						<p className="text-sm text-muted-foreground">No Skills in this Project.</p>
					) : null}
					{value?.description ? (
						<p className="text-sm text-muted-foreground">{value.description}</p>
					) : null}
				</div>
			) : null}
			{skills.error ? (
				<ApiErrorPanel
					error={skills.error}
					onRetry={() => void skills.refetch()}
					title="Couldn't load Library Skills"
				/>
			) : null}
			<p className="text-xs text-muted-foreground">
				This Agent will use the Skill from your Library and receive its updates.
			</p>
		</div>
	);
}
