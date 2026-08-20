import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isGeneratedRuntimeSystemdFile } from "./systemd-user";

export const RUNTIME_SYSTEMD_DROP_IN_FILE = "10-clawdi-hosted.conf";

export type ManagedRuntimeSystemdUnitEntry = {
	unitName: string;
	path: string;
} & (
	| { kind: "base-unit"; generatedContents?: string }
	| { kind: "hosted-drop-in"; generatedContents: string }
);

export function managedRuntimeSystemdUnitEntries(
	root: string,
	readContents: (path: string) => string | null = readRuntimeSystemdContents,
): ManagedRuntimeSystemdUnitEntry[] {
	if (!existsSync(root)) return [];
	const managed: ManagedRuntimeSystemdUnitEntry[] = [];
	for (const entry of readdirSync(root)) {
		if (entry.endsWith(".service")) {
			const path = join(root, entry);
			if (entry.startsWith("clawdi-")) {
				managed.push({ kind: "base-unit", unitName: entry, path });
			} else {
				const generatedContents = generatedRuntimeSystemdContents(path, readContents);
				if (generatedContents !== null) {
					managed.push({ kind: "base-unit", unitName: entry, path, generatedContents });
				}
			}
			continue;
		}
		if (!entry.endsWith(".service.d")) continue;
		const path = join(root, entry, RUNTIME_SYSTEMD_DROP_IN_FILE);
		const generatedContents = generatedRuntimeSystemdContents(path, readContents);
		if (generatedContents === null) continue;
		managed.push({
			kind: "hosted-drop-in",
			unitName: entry.slice(0, -".d".length),
			path,
			generatedContents,
		});
	}
	return managed;
}

export function isGeneratedRuntimeSystemdPath(path: string): boolean {
	return generatedRuntimeSystemdContents(path, readRuntimeSystemdContents) !== null;
}

function readRuntimeSystemdContents(path: string): string | null {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return null;
	}
}

function generatedRuntimeSystemdContents(
	path: string,
	readContents: (path: string) => string | null,
): string | null {
	const contents = readContents(path);
	return contents !== null && isGeneratedRuntimeSystemdFile(contents) ? contents : null;
}

export function systemctlPath(): string {
	return process.env.CLAWDI_SYSTEMCTL_PATH?.trim() || "systemctl";
}

export function parseSystemctlShow(output: string): Record<string, string> {
	return Object.fromEntries(
		output
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => {
				const separator = line.indexOf("=");
				return separator < 0 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
			}),
	);
}
