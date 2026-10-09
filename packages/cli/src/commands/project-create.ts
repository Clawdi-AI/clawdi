import chalk from "chalk";
import { ApiClient, unwrap } from "../lib/api-client";
import { emit } from "../lib/command-output";
import { projectAuthOrExit } from "../lib/project-command-utils";

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

	const slug = normalizeSlugInput(opts.slug);
	const project = unwrap(
		await new ApiClient({ baseUrl: apiUrl, authToken: apiKey }).POST("/v1/projects", {
			body: { name, ...(slug ? { slug } : {}) },
		}),
	);
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
