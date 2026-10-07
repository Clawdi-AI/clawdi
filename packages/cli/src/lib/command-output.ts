import { progressLine } from "./progress";

export type JsonOutputOptions = { json?: boolean };

/**
 * Resolve the command's machine-readable output mode.
 *
 * The non-TTY fallback is a frozen compatibility contract for commands that
 * shipped before `--json`; see docs/cli-development.md. New commands should
 * pass only `{ json: true }` and opt in explicitly.
 */
export function wantsJson(
	opts: JsonOutputOptions | boolean | undefined,
	options: { legacyImplicit?: boolean } = {},
): boolean {
	const explicit = typeof opts === "boolean" ? opts : opts?.json === true;
	return explicit || (options.legacyImplicit === true && process.stdout.isTTY !== true);
}

/** Emit one machine-readable result object with its schema version. */
export function emit(schemaVersion: string, result: Record<string, unknown>): void {
	emitJson({ ...result, schemaVersion }, false);
}

/** Emit a legacy JSON shape without changing its documented envelope. */
export function emitJson(
	value: unknown,
	pretty = true,
	write: (text: string) => void = console.log,
): void {
	write(JSON.stringify(value, null, pretty ? 2 : undefined));
}

/** Keep human messages out of machine-readable stdout. */
export function message(json: boolean | undefined, messageText = ""): void {
	if (json) progressLine(messageText);
	else console.log(messageText);
}

/** @deprecated Prefer `message` at new call sites. */
export function commandMessage(json: boolean | undefined, messageText = ""): void {
	message(json, messageText);
}

/** Emit a result only when the command selected JSON output. */
export function commandResult(
	json: boolean | undefined,
	schemaVersion: string,
	result: Record<string, unknown>,
): void {
	if (json) emit(schemaVersion, result);
}
