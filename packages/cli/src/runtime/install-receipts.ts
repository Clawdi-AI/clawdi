import { lstatSync, readFileSync } from "node:fs";
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
		companions: z.record(z.string().min(1), installReceiptEntrySchema).default({}),
	})
	.strict();

export type RuntimeInstallReceipts = z.infer<typeof runtimeInstallReceiptsSchema>;
export type RuntimeInstallReceiptEntry = z.infer<typeof installReceiptEntrySchema>;

export function emptyRuntimeInstallReceipts(): RuntimeInstallReceipts {
	return {
		schemaVersion: "clawdi.runtimeInstallReceipts.v1",
		officialServices: {},
		channelPlugins: {},
		companions: {},
	};
}

export function runtimeInstallReceiptsPath(paths: RuntimePaths): string {
	return join(paths.serviceStateRoot, "status", "runtime-install-receipts.json");
}

export function readRuntimeInstallReceipts(paths: RuntimePaths): RuntimeInstallReceipts | null {
	const path = runtimeInstallReceiptsPath(paths);
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw runtimeInstallReceiptError("could not be inspected", error);
	}
	if (!stat.isFile()) {
		throw new Error("runtime install receipts are not a trusted regular file");
	}
	if ((stat.mode & 0o777) !== 0o600) {
		throw new Error("runtime install receipts do not have private file permissions");
	}
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
		throw new Error("runtime install receipts do not have the expected file owner");
	}

	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw runtimeInstallReceiptError("could not be decoded", error);
	}
	const parsed = runtimeInstallReceiptsSchema.safeParse(value);
	if (!parsed.success) throw new Error("runtime install receipts do not match the expected schema");
	return parsed.data;
}

export function writeRuntimeInstallReceipts(
	receipts: RuntimeInstallReceipts,
	paths: RuntimePaths,
): void {
	const parsed = runtimeInstallReceiptsSchema.parse(receipts);
	try {
		writePrivateFileAtomic(
			runtimeInstallReceiptsPath(paths),
			`${JSON.stringify(parsed, null, 2)}\n`,
			{
				mode: 0o600,
				dirMode: 0o755,
			},
		);
	} catch (error) {
		throw runtimeInstallReceiptError("could not be persisted", error);
	}
	const persisted = readRuntimeInstallReceipts(paths);
	if (!persisted || JSON.stringify(persisted) !== JSON.stringify(parsed)) {
		throw new Error("runtime install receipts did not pass post-write verification");
	}
}

function runtimeInstallReceiptError(message: string, error: unknown): Error {
	const code =
		typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
			? ` (${error.code})`
			: "";
	return new Error(`runtime install receipts ${message}${code}`);
}
