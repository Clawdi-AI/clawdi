import { progressLine } from "./progress";

export type JsonOutputOptions = { json?: boolean };

/** Resolve machine-readable output mode. JSON is opt-in via --json. */
export function wantsJson(opts: JsonOutputOptions | boolean | undefined): boolean {
	return typeof opts === "boolean" ? opts : opts?.json === true;
}

/** Emit a versioned JSON envelope, formatted consistently for every command. */
export function emit<T extends { schemaVersion: string }>(
	value: T,
	write: (text: string) => void = console.log,
): void {
	write(JSON.stringify(value, null, 2));
}

/** Keep human messages out of machine-readable stdout. */
export function message(json: boolean | undefined, messageText = ""): void {
	if (json) progressLine(messageText);
	else console.log(messageText);
}

/** Emit a result only when the command selected JSON output. */
export function commandResult(
	json: boolean | undefined,
	schemaVersion: string,
	result: Record<string, unknown>,
): void {
	if (json) emit({ ...result, schemaVersion });
}
