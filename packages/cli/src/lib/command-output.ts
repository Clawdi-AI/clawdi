import { progressLine } from "./progress";

export type JsonOutputOptions = { json?: boolean };

/** Resolve machine-readable output mode. JSON is opt-in via --json. */
export function wantsJson(opts: JsonOutputOptions | boolean | undefined): boolean {
	return typeof opts === "boolean" ? opts : opts?.json === true;
}

/**
 * Emit one JSON value to stdout. The object form is the only supported
 * command contract: callers should include a schemaVersion and named arrays.
 * The two-argument form adds a schemaVersion for commandResult callers.
 */
export function emit(value: unknown, pretty?: boolean, write?: (text: string) => void): void;
export function emit(schemaVersion: string, result: Record<string, unknown>): void;
export function emit(
	valueOrSchema: unknown,
	prettyOrResult: boolean | Record<string, unknown> = true,
	write: (text: string) => void = console.log,
): void {
	const value =
		typeof prettyOrResult === "object" && prettyOrResult !== null
			? { ...prettyOrResult, schemaVersion: valueOrSchema }
			: valueOrSchema;
	const pretty = typeof prettyOrResult === "boolean" ? prettyOrResult : false;
	write(JSON.stringify(value, null, pretty ? 2 : undefined));
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
	if (json) emit(schemaVersion, result);
}
