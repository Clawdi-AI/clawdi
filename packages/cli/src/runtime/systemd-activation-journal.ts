import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { RuntimePaths } from "./paths";
import { writeRuntimePlatformFileAtomic } from "./state";

const journalSchema = z
	.object({
		schemaVersion: z.literal("clawdi.systemdActivationJournal.v1"),
		pending: z.record(
			z.string().regex(/^[A-Za-z0-9_.@-]+\.service$/),
			z.string().regex(/^[a-f0-9]{64}$/),
		),
	})
	.strict();

export function readSystemdActivationJournal(paths: RuntimePaths): Record<string, string> {
	let content: string;
	try {
		content = readFileSync(
			join(dirname(paths.appliedState), "systemd-activation-journal.json"),
			"utf8",
		);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
		throw error;
	}
	try {
		return journalSchema.parse(JSON.parse(content) as unknown).pending;
	} catch {
		// Uncertain activation must fail closed; never include persisted input in errors.
		throw new Error("systemd activation journal is invalid");
	}
}

function writeJournal(paths: RuntimePaths, pending: Record<string, string>): void {
	const journal = journalSchema.parse({
		schemaVersion: "clawdi.systemdActivationJournal.v1",
		pending,
	});
	writeRuntimePlatformFileAtomic(
		paths,
		join(dirname(paths.appliedState), "systemd-activation-journal.json"),
		`${JSON.stringify(journal)}\n`,
		{ mode: 0o600, dirMode: 0o755, durable: paths.mode === "hosted" },
	);
}

/** Persist before a start/restart: its outcome can outlive a failed apply or process. */
export function recordSystemdActivationIntent(
	paths: RuntimePaths,
	candidates: Record<string, string>,
): void {
	if (Object.keys(candidates).length === 0) return;
	writeJournal(paths, { ...readSystemdActivationJournal(paths), ...candidates });
}

/** Only a committed receipt or fully verified last-good replay can acknowledge intent. */
export function clearSystemdActivationJournal(paths: RuntimePaths): void {
	if (Object.keys(readSystemdActivationJournal(paths)).length > 0) writeJournal(paths, {});
}
