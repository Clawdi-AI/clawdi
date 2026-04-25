import chalk from "chalk";
import { ApiError } from "./api-client";

/** Best-effort `String`-of an `unknown` caught from a try/catch. */
export function errMessage(e: unknown): string {
	if (e instanceof Error) return e.message;
	if (typeof e === "string") return e;
	return "Something went wrong.";
}

/** Top-level error handler wired into `program.parseAsync().catch(handleError)`. */
export function handleError(err: unknown): never {
	if (err instanceof ApiError) {
		console.error();
		console.error(chalk.red(`✗ ${err.message}`));
		if (err.hint) console.error(chalk.gray(`  ${err.hint}`));
		process.exit(1);
	}
	if (err instanceof Error) {
		console.error();
		console.error(chalk.red(`✗ ${err.message}`));
		if (process.env.CLAWDI_DEBUG) console.error(chalk.gray(err.stack ?? ""));
		process.exit(1);
	}
	console.error(chalk.red(`✗ Unexpected error: ${String(err)}`));
	process.exit(1);
}
