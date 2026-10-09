import chalk from "chalk";
import { ApiClient, ApiError, readJson } from "../lib/api-client";
import { emit } from "../lib/command-output";
import { projectAuthOrExit } from "../lib/project-command-utils";

interface ProjectRow {
	id: string;
	name: string;
	slug: string;
	kind: string;
	is_owner?: boolean;
}

function normalizeSlugInput(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const slug = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || undefined;
}

export async function projectCreateCommand(
	name: string,
	opts: { slug?: string; json?: boolean } = {},
): Promise<void> {
	const ctx = await projectAuthOrExit();
	if (!ctx) return;
	const { apiUrl, apiKey } = ctx;

	const payload: { name: string; slug?: string } = { name };
	const slug = normalizeSlugInput(opts.slug);
	if (slug) payload.slug = slug;

	const r = await new ApiClient({ baseUrl: apiUrl, authToken: apiKey }).request("/v1/projects", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify(payload),
	});

	if (!r.ok) {
		throw new ApiError({ status: r.status, body: await r.text(), hint: "" });
	}

	const project = await readJson<ProjectRow>(r, "create project");
	if (opts.json) {
		emit({ schemaVersion: "clawdi.projectCreate.v1", status: "created", project });
		return;
	}

	console.log(
		chalk.green("✓") +
			` Created project ${chalk.bold(project.name)} ` +
			chalk.gray(`(${project.slug}, ${project.id})`),
	);
	console.log(chalk.gray("Share it: ") + chalk.cyan(`clawdi project share ${project.slug}`));
}
