import { stripVTControlCharacters } from "node:util";
import * as clack from "@clack/prompts";

/** Progress always belongs on stderr, including when stdout is a JSON document. */
export function progressLine(message = ""): void {
	process.stderr.write(`${process.stderr.isTTY ? message : stripVTControlCharacters(message)}\n`);
}

function plainOrClack(render: (message: string, opts: clack.CommonOptions) => void) {
	return (message = "", opts?: clack.CommonOptions): void => {
		if (process.stderr.isTTY) render(message, { ...opts, output: process.stderr });
		else progressLine(message);
	};
}

export function createProgress(): Pick<clack.SpinnerResult, "start" | "stop" | "message"> {
	if (process.stderr.isTTY) return clack.spinner({ output: process.stderr });
	return {
		start: progressLine,
		stop: progressLine,
		// Intermediate updates replace the spinner in a TTY. Piped logs need
		// only the start and final lines, rather than one line per item.
		message: () => {},
	};
}

export const progress = {
	spinner: createProgress,
	intro: plainOrClack(clack.intro),
	outro: plainOrClack(clack.outro),
	log: {
		message: plainOrClack(clack.log.message),
		info: plainOrClack(clack.log.info),
		success: plainOrClack(clack.log.success),
		step: plainOrClack(clack.log.step),
		warn: plainOrClack(clack.log.warn),
		error: plainOrClack(clack.log.error),
	},
};
