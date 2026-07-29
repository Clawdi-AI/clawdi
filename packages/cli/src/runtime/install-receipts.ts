import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writePrivateFileAtomic } from "../lib/private-file";
import type { RuntimePaths } from "./paths";

const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/);

const installReceiptEntrySchema = z
	.object({
		desiredRevision: revisionSchema,
		currentRevision: revisionSchema,
	})
	.strict();

const runtimeInstallReceiptsSchema = z
	.object({
		schemaVersion: z.literal("clawdi.runtimeInstallReceipts.v1"),
		officialServices: z.record(z.string().min(1), installReceiptEntrySchema),
		channelPlugins: z.record(z.string().min(1), installReceiptEntrySchema),
	})
	.strict();

export type RuntimeInstallReceipts = z.infer<typeof runtimeInstallReceiptsSchema>;
export type RuntimeInstallReceiptEntry = z.infer<typeof installReceiptEntrySchema>;

export function emptyRuntimeInstallReceipts(): RuntimeInstallReceipts {
	return {
		schemaVersion: "clawdi.runtimeInstallReceipts.v1",
		officialServices: {},
		channelPlugins: {},
	};
}

export function runtimeInstallReceiptsPath(paths: RuntimePaths): string {
	return join(paths.serviceStateRoot, "status", "runtime-install-receipts.json");
}

export function readRuntimeInstallReceipts(paths: RuntimePaths): RuntimeInstallReceipts | null {
	const path = runtimeInstallReceiptsPath(paths);
	if (!existsSync(path)) return null;
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) return null;
		if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return null;
		if (typeof process.getgid === "function" && stat.gid !== process.getgid()) return null;
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		const parsed = runtimeInstallReceiptsSchema.safeParse(value);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

export function writeRuntimeInstallReceipts(
	receipts: RuntimeInstallReceipts,
	paths: RuntimePaths,
): void {
	const parsed = runtimeInstallReceiptsSchema.parse(receipts);
	writePrivateFileAtomic(
		runtimeInstallReceiptsPath(paths),
		`${JSON.stringify(parsed, null, 2)}\n`,
		{
			mode: 0o600,
			dirMode: 0o755,
		},
	);
}
