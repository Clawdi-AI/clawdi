import chalk from "chalk";

import { ApiError } from "../lib/api-client";
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

function formatDetail(body: unknown): string {
	if (typeof body === "string") return body;
	if (!body || typeof body !== "object") return "Unknown error";
	const detail = (body as { detail?: unknown }).detail;
	if (typeof detail === "string") return detail;
	if (Array.isArray(detail)) {
		return detail
			.map((item) => {
				if (!item || typeof item !== "object") return String(item);
				const msg = (item as { msg?: unknown }).msg;
				const loc = (item as { loc?: unknown }).loc;
				return `${Array.isArray(loc) ? `${loc.join(".")}: ` : ""}${String(msg ?? item)}`;
			})
			.join("; ");
	}
	return JSON.stringify(detail);
}

export async function projectCreateCommand(
	name: string,
	opts: { slug?: string; json?: boolean } = {},
): Promise<void> {
	const ctx = projectAuthOrExit();
	if (!ctx) return;
	const { apiUrl, apiKey } = ctx;

	const payload: { name: string; slug?: string } = { name };
	const slug = normalizeSlugInput(opts.slug);
	if (slug) payload.slug = slug;

	const r = await fetch(`${apiUrl}/api/projects`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(payload),
	});

	if (!r.ok) {
		const body = await r.json().catch(async () => await r.text());
		if (r.status === 400 || r.status === 403 || r.status === 409 || r.status === 422) {
			console.error(chalk.red(`Failed to create project: ${formatDetail(body)}`));
			process.exitCode = 1;
			return;
		}
		throw new ApiError({ status: r.status, body: JSON.stringify(body), hint: "" });
	}

	const project = (await r.json()) as ProjectRow;
	if (opts.json) {
		console.log(JSON.stringify({ status: "created", project }, null, 2));
		return;
	}

	console.log(
		chalk.green("✓") +
			` Created project ${chalk.bold(project.name)} ` +
			chalk.gray(`(${project.slug}, ${project.id.slice(0, 8)}…)`),
	);
	console.log(chalk.gray("Share it: ") + chalk.cyan(`clawdi project share ${project.slug}`));
}
