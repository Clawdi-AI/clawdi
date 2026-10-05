import { readFileSync } from "node:fs";
import { totalmem } from "node:os";
import { posix } from "node:path";

const MIB = 1024 * 1024;
const BEGIN = "# ClawdiOOMProtection=v1";
const END = "# EndClawdiOOMProtection";

function readOptional(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			["ENOENT", "EACCES", "EPERM"].includes(String(error.code))
		) {
			return null;
		}
		throw error;
	}
}

/** systemd percentages use physical RAM; use the tighter visible cgroup limit. */
export function runtimeMemoryBudget(
	read: (path: string) => string | null = readOptional,
	physicalMemory = totalmem(),
): number {
	let budget = physicalMemory;
	const root = "/sys/fs/cgroup";
	const relative = read("/proc/self/cgroup")
		?.split(/\r?\n/)
		.find((line) => line.startsWith("0::/"))
		?.slice(4);
	// Reject traversal rather than following an unexpected kernel/fixture path.
	let current =
		relative !== undefined && !relative.split("/").includes("..")
			? posix.join(root, relative)
			: root;
	for (;;) {
		const raw = read(posix.join(current, "memory.max"))?.trim();
		if (raw && /^\d+$/.test(raw)) {
			const limit = Number(raw);
			if (Number.isSafeInteger(limit) && limit > 0) budget = Math.min(budget, limit);
		}
		if (current === root) break;
		current = posix.dirname(current);
	}
	return budget;
}

/** Keep the gateway killable, and use only the runtimes' native child controls. */
export function gatewayOomProtectionLines(
	runtime: "hermes" | "openclaw",
	memoryBytes: number,
): string[] {
	const toolMemoryMiB = Math.max(64, Math.floor(memoryBytes / MIB / 2));
	return [
		BEGIN,
		"OOMPolicy=continue",
		...(runtime === "hermes" ? [`Environment=TERMINAL_LOCAL_MEMORY_MAX_MB=${toolMemoryMiB}`] : []),
		END,
	];
}

export function platformOomProtectionLines(): string[] {
	return [BEGIN, "OOMPolicy=continue", END];
}

/** These settings may wait for a natural start; changing them must not restart a gateway. */
export function withoutOomProtection(contents: string): string {
	return contents.replace(
		/^# ClawdiOOMProtection=v1\r?\n(?:OOMScoreAdjust=-900\r?\n)?OOMPolicy=continue\r?\n(?:Environment=TERMINAL_LOCAL_MEMORY_MAX_MB=[1-9]\d*\r?\n)?# EndClawdiOOMProtection(?:\r?\n|$)/gm,
		"",
	);
}
