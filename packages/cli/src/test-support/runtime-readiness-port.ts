import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Keep the native probe URL while connecting real curl to a private fixture port. */
export function routeRuntimeReadinessPort(
	root: string,
	nativePort: number,
	fixturePort: number | undefined,
): () => void {
	for (const port of [nativePort, fixturePort]) {
		if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)
			throw new Error("Invalid fixture port");
	}
	const curl = execFileSync("which", ["curl"], { encoding: "utf8" }).trim();
	const bin = join(root, "readiness-bin");
	mkdirSync(bin, { recursive: true });
	writeFileSync(
		join(bin, "curl"),
		`#!/bin/sh\nexec '${curl.replaceAll("'", "'\\''")}' --disable --connect-to '127.0.0.1:${nativePort}:127.0.0.1:${fixturePort}' "$@"\n`,
		{ mode: 0o700 },
	);
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}:${previousPath ?? ""}`;
	return () => {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
	};
}
