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
		process.stderr.write("\n");
		console.error(chalk.red(`✗ ${err.message}`));
		if (err.hint) console.error(chalk.gray(`  ${err.hint}`));
		if (process.env.CLAWDI_DEBUG) {
			if (err.status > 0) console.error(chalk.gray(`  HTTP ${err.status}`));
			console.error(chalk.gray(err.stack ?? ""));
		}
		process.exit(1);
	}
	if (err instanceof Error) {
		process.stderr.write("\n");
		const unexpected =
			err instanceof TypeError ||
			err instanceof RangeError ||
			err instanceof ReferenceError ||
			err instanceof SyntaxError ||
			err instanceof URIError ||
			err instanceof EvalError;
		console.error(chalk.red(`✗ ${unexpected ? unexpectedErrorMessage(err.message) : err.message}`));
		if (process.env.CLAWDI_DEBUG) console.error(chalk.gray(err.stack ?? ""));
		process.exit(1);
	}
	console.error(chalk.red(`✗ ${unexpectedErrorMessage(errMessage(err))}`));
	process.exit(1);
}

function unexpectedErrorMessage(message: string): string {
	return `Unexpected error (${message}). Re-run with CLAWDI_DEBUG=1 and report at https://github.com/Clawdi-AI/clawdi/issues.`;
}
