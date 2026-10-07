import chalk from "chalk";

import { ApiClient, ApiError, unwrap } from "../lib/api-client";
import { projectAuthOrExit } from "../lib/project-command-utils";
import { resolveProjectId } from "../lib/project-resolver";
import { confirmOrRequireYes } from "../lib/prompts";

export async function projectRmCommand(
	projectArg: string,
	opts: { yes?: boolean; json?: boolean } = {},
): Promise<void> {
	const ctx = await projectAuthOrExit();
	if (!ctx) return;
	const projectId = await resolveProjectId(ctx.apiUrl, ctx.apiKey, projectArg);
	if (
		!(await confirmOrRequireYes(`Archive project ${projectArg}?`, {
			yes: opts.yes,
			action: "archive this project",
		}))
	)
		return;

	try {
		unwrap(
			await new ApiClient({ baseUrl: ctx.apiUrl, authToken: ctx.apiKey }).DELETE(
				"/v1/projects/{project_id}",
				{ params: { path: { project_id: projectId } } },
			),
		);
	} catch (error) {
		if (
			error instanceof ApiError &&
			error.status >= 400 &&
			error.status < 500 &&
			error.status !== 401
		) {
			throw new Error("This project can't be archived (only projects you created).");
		}
		throw error;
	}

	if (opts.json) {
		console.log(
			JSON.stringify(
				{ schemaVersion: "clawdi.projectRm.v1", id: projectId, status: "archived" },
				null,
				2,
			),
		);
		return;
	}
	console.log(`${chalk.green("✓")} Archived project ${projectArg}.`);
}
