import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const HERMES_DASHBOARD_BUILD_REVISION_FILE = ".clawdi-runtime-revision";

/** Shared software build cache; callers own execution environment and file identity. */
export function prepareHermesDashboardBuild(input: {
	home: string;
	revision: string | null;
	run: (args: string[], cwd: string, timeoutMs: number) => void;
	writeRevision: (path: string, contents: string) => void;
}): void {
	const appRoot = join(input.home, ".hermes", "hermes-agent");
	const index = join(appRoot, "hermes_cli", "web_dist", "index.html");
	const revisionFile = join(dirname(index), HERMES_DASHBOARD_BUILD_REVISION_FILE);
	if (
		input.revision &&
		existsSync(index) &&
		existsSync(revisionFile) &&
		readFileSync(revisionFile, "utf8").trim() === input.revision
	) {
		return;
	}
	input.run(["ci", "--include=dev", "--workspace", "web"], appRoot, 600_000);
	input.run(["run", "build"], join(appRoot, "web"), 900_000);
	if (!existsSync(index)) throw new Error(`Hermes dashboard prerequisite did not produce ${index}`);
	if (input.revision) input.writeRevision(revisionFile, `${input.revision}\n`);
}
