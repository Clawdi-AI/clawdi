import chalk from "chalk";
import { ApiError } from "./api-client";
import { ClerkOAuthError } from "./clerk-oauth";
import { HostedDeployAuthorizationError } from "./hosted-deploy-auth";
import { AuthorizationRequiredError } from "./require-auth";

const AUTH_REQUIRED_CODES = new Set([
	"hosted_oauth_login_required",
	"hosted_token_expired",
	"invalid_hosted_token",
	"invalid_hosted_token_expiry",
	"oauth_login_required",
	"oauth_login_expired",
]);

export type HttpErrorMapping = {
	code: string;
	message: string;
	exitCode: 1 | 4;
};

/** Map authenticated HTTP failures without classifying by response text. */
export function mapHttpError(
	error: { status: number; code?: string },
	service = "Clawdi",
): HttpErrorMapping | null {
	if (error.status === 401 || (error.code !== undefined && AUTH_REQUIRED_CODES.has(error.code))) {
		return {
			code: `${service.toLowerCase().replaceAll(" ", "_")}_auth_required`,
			message: "CLI authorization was rejected. Run `clawdi auth login`, then try again.",
			exitCode: 4,
		};
	}
	if (error.status === 403) {
		return {
			code: `${service.toLowerCase().replaceAll(" ", "_")}_forbidden`,
			message: "You don't have permission to perform this action from the CLI. Use the dashboard.",
			exitCode: 1,
		};
	}
	return null;
}

/** Best-effort `String`-of an `unknown` caught from a try/catch. */
export function errMessage(e: unknown): string {
	if (e instanceof Error) return e.message;
	if (typeof e === "string") return e;
	return "Something went wrong.";
}

/** Top-level error handler wired into `program.parseAsync().catch(handleError)`. */
export function handleError(err: unknown): never {
	if (isAuthorizationRequired(err)) {
		process.stderr.write("\n");
		const mapped = err instanceof ApiError ? mapHttpError(err) : null;
		console.error(chalk.red(`✗ ${mapped?.message ?? errMessage(err)}`));
		if (process.env.CLAWDI_DEBUG) {
			if (err instanceof ApiError && err.status > 0)
				console.error(chalk.gray(`  HTTP ${err.status}`));
			if (err instanceof Error) console.error(chalk.gray(err.stack ?? ""));
		}
		process.exit(4);
	}
	if (err instanceof ApiError) {
		process.stderr.write("\n");
		const mapped = mapHttpError(err);
		console.error(chalk.red(`✗ ${mapped?.message ?? err.message}`));
		if (err.hint && !err.message.includes(err.hint)) console.error(chalk.gray(`  ${err.hint}`));
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

export function isAuthorizationRequired(err: unknown): err is Error {
	if (err instanceof AuthorizationRequiredError) return true;
	if (err instanceof ApiError) return mapHttpError(err)?.exitCode === 4;
	if (err instanceof HostedDeployAuthorizationError)
		return mapHttpError({ status: 0, code: err.code })?.exitCode === 4;
	if (err instanceof ClerkOAuthError)
		return mapHttpError({ status: 0, code: err.code })?.exitCode === 4;
	return false;
}

function unexpectedErrorMessage(message: string): string {
	return `Unexpected error (${message}). Re-run with CLAWDI_DEBUG=1 and report at https://github.com/Clawdi-AI/clawdi/issues.`;
}
