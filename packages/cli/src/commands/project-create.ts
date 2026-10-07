import chalk from "chalk";
import { ApiClient, ApiError, readJson } from "../lib/api-client";
import { emitJson } from "../lib/command-output";
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

async function parseErrorBody(r: Response): Promise<unknown> {
	const text = await r.text();
	if (!text) return "";
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
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
		const body = await parseErrorBody(r);
		if (r.status === 400 || r.status === 403 || r.status === 409 || r.status === 422) {
			console.error(chalk.red(`Failed to create project: ${formatDetail(body)}`));
			process.exitCode = 1;
			return;
		}
		throw new ApiError({ status: r.status, body: JSON.stringify(body), hint: "" });
	}

	const project = await readJson<ProjectRow>(r, "create project");
	if (opts.json) {
		emitJson({ status: "created", project });
		return;
	}

	console.log(
		chalk.green("✓") +
			` Created project ${chalk.bold(project.name)} ` +
			chalk.gray(`(${project.slug}, ${project.id})`),
	);
	console.log(chalk.gray("Share it: ") + chalk.cyan(`clawdi project share ${project.slug}`));
}
