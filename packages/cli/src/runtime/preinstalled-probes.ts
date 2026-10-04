import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { detectRuntimeMode, getRuntimePaths } from "./paths";

export const PREINSTALLATION_RECEIPT_RELATIVE_PATH = join("preinstallation", "receipt.json");

/**
 * Probe answers captured by anonymous preinstallation. They are reused only while
 * the exact launcher file and installed source identity are unchanged, so any
 * tenant update or reinstall falls back to the normal runtime probes.
 */
export const preinstalledProbesSchema = z
	.object({
		runtime: z.enum(["openclaw", "hermes"]),
		command: z.string().startsWith("/"),
		home: z.string().startsWith("/"),
		executableRevision: z.string().min(1),
		sourceIdentity: z.string().min(1),
		version: z.string().min(1),
		configPath: z.string().startsWith("/").optional(),
	})
	.strict();
export type PreinstalledProbes = z.infer<typeof preinstalledProbesSchema>;

/** Exact installed source: Hermes git commit or OpenClaw package version. */
export function preinstalledSourceIdentity(
	runtime: PreinstalledProbes["runtime"],
	home: string,
): string | null {
	try {
		if (runtime === "hermes") {
			const commit = gitHeadCommit(join(home, ".hermes/hermes-agent/.git"));
			return commit ? `git:${commit}` : null;
		}
		const manifest = z
			.object({ name: z.literal("openclaw"), version: z.string().min(1) })
			.loose()
			.parse(
				JSON.parse(
					readFileSync(
						join(home, ".local/tools/node/lib/node_modules/openclaw/package.json"),
						"utf8",
					),
				),
			);
		return `npm:openclaw@${manifest.version}`;
	} catch {
		return null;
	}
}

/** Resolve HEAD without spawning git: detached commit, loose ref or packed ref. */
function gitHeadCommit(gitDir: string): string | null {
	const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
	if (/^[a-f0-9]{40}$/.test(head)) return head;
	const ref = /^ref: (refs\/[A-Za-z0-9._/-]+)$/.exec(head)?.[1];
	if (!ref || ref.split("/").includes("..")) return null;
	let commit: string | null = null;
	try {
		commit = readFileSync(join(gitDir, ref), "utf8").trim();
	} catch {
		for (const line of readFileSync(join(gitDir, "packed-refs"), "utf8").split("\n")) {
			const [sha, name] = line.trim().split(" ");
			if (name === ref) commit = sha ?? null;
		}
	}
	return commit && /^[a-f0-9]{40}$/.test(commit) ? commit : null;
}

let trustedReceiptOwner = 0;
let cachedReceipt: { probes: PreinstalledProbes | null } | null = null;

function readReceiptProbes(): PreinstalledProbes | null {
	if (cachedReceipt) return cachedReceipt.probes;
	let probes: PreinstalledProbes | null = null;
	try {
		if (detectRuntimeMode() === "hosted") {
			const path = join(getRuntimePaths().serviceStateRoot, PREINSTALLATION_RECEIPT_RELATIVE_PATH);
			const stat = lstatSync(path);
			// Only the root-owned, non-writable receipt sealed by preparation is trusted.
			if (stat.isFile() && stat.uid === trustedReceiptOwner && (stat.mode & 0o222) === 0) {
				const receipt = z
					.object({ probes: preinstalledProbesSchema })
					.loose()
					.parse(JSON.parse(readFileSync(path, "utf8")));
				probes = receipt.probes;
			}
		}
	} catch {
		probes = null;
	}
	cachedReceipt = { probes };
	return probes;
}

function matchingProbes(
	command: string,
	home: string,
	executableRevision: string,
): PreinstalledProbes | null {
	const probes = readReceiptProbes();
	if (
		!probes ||
		probes.command !== command ||
		probes.home !== home ||
		probes.executableRevision !== executableRevision ||
		preinstalledSourceIdentity(probes.runtime, home) !== probes.sourceIdentity
	) {
		return null;
	}
	return probes;
}

export function preinstalledRuntimeVersion(
	command: string,
	home: string,
	executableRevision: string,
): string | null {
	return matchingProbes(command, home, executableRevision)?.version ?? null;
}

export function preinstalledHermesConfigPath(
	command: string,
	home: string,
	executableRevision: string | null,
	environment: Record<string, string> | undefined,
): string | null {
	if (!executableRevision || environment !== undefined || process.env.HERMES_HOME !== undefined) {
		return null;
	}
	const probes = matchingProbes(command, home, executableRevision);
	return probes?.runtime === "hermes" ? (probes.configPath ?? null) : null;
}

export function resetPreinstalledProbesForTest(owner = 0): void {
	trustedReceiptOwner = owner;
	cachedReceipt = null;
}
