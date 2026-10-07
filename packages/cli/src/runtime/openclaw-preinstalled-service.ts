import { lstatSync, readFileSync, rmSync } from "node:fs";
import { totalmem } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { RuntimePaths } from "./paths";
import { writeRuntimePlatformFileAtomic } from "./state";

const receiptSchema = z
	.object({
		schemaVersion: z.literal("clawdi.openclawPreinstalledService.v1"),
		serviceRevision: z.string().regex(/^[a-f0-9]{64}$/),
		memoryBytes: z.number().int().positive().safe(),
	})
	.strict();

function receiptPath(paths: RuntimePaths): string {
	return join(paths.statusRoot, "openclaw-preinstalled-service.json");
}

/** Match the official installer's constrained-memory / physical-memory policy. */
function availableMemoryBytes(): number {
	const constrained = process.constrainedMemory();
	const physical = totalmem();
	return Number.isSafeInteger(constrained) && constrained > 0 && constrained <= physical
		? constrained
		: physical;
}

export function recordOpenClawPreinstalledService(
	paths: RuntimePaths,
	serviceRevision: string,
): void {
	const receipt = receiptSchema.parse({
		schemaVersion: "clawdi.openclawPreinstalledService.v1",
		serviceRevision,
		memoryBytes: availableMemoryBytes(),
	});
	writeRuntimePlatformFileAtomic(paths, receiptPath(paths), `${JSON.stringify(receipt)}\n`, {
		mode: 0o600,
	});
}

/** Only a still-unmodified prepared unit may be replaced for capacity changes.
 * Native updates and user edits retain their own service authority. */
export function openClawPreinstalledServiceNeedsRefresh(
	paths: RuntimePaths,
	serviceRevision: string,
): boolean {
	try {
		const path = receiptPath(paths);
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
			throw new Error("OpenClaw preinstalled service receipt is not private platform state");
		const receipt = receiptSchema.parse(JSON.parse(readFileSync(path, "utf8")));
		return (
			receipt.serviceRevision === serviceRevision && receipt.memoryBytes !== availableMemoryBytes()
		);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}

export function forgetOpenClawPreinstalledService(paths: RuntimePaths): void {
	rmSync(receiptPath(paths), { force: true });
}
