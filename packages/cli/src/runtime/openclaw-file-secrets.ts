import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, readdirSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { readPrivateFileEvidence, writePrivateFileAtomic } from "../lib/private-file";
import { assertDirectoryIdentity, openTrustedDirectory } from "../lib/trusted-directory";
import { isPlainRecord, recordValue } from "./manifest-shared";
import { readPlainOpenClawConfig, visitOpenClawConfigDocuments } from "./openclaw-config";

export const OPENCLAW_FILE_SECRET_PROVIDER = "clawdi-runtime";

/**
 * Project credential references owned by this config patch. The versioned
 * path makes a key rotation a config change, so OpenClaw reloads the file in the
 * same transaction as the models, without an authenticated secrets.reload RPC.
 * Called under the runtime filesystem identity; directories are 0700, files 0600.
 */
export function projectOpenClawProviderFileSecrets(
	content: string,
	environment: Record<string, string>,
	home: string,
	referencedKeys = openClawFileSecretEnvironmentKeys(home),
): string {
	const patch = recordValue(JSON.parse(content) as unknown);
	if (!patch) throw new Error("OpenClaw provider patch must be an object");
	const values: Record<string, string> = {};
	let projected = false;
	const project = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const child of value) project(child);
			return;
		}
		if (!isPlainRecord(value)) return;
		for (const [key, child] of Object.entries(value)) {
			if (
				isPlainRecord(child) &&
				child.source === "env" &&
				typeof child.id === "string" &&
				Object.hasOwn(environment, child.id)
			) {
				projected = true;
				referencedKeys.add(child.id);
				value[key] = {
					source: "file",
					provider: OPENCLAW_FILE_SECRET_PROVIDER,
					id: `/${child.id}`,
				};
			} else project(child);
		}
	};
	project(patch);
	if (!projected) return content;
	for (const key of referencedKeys) {
		if (Object.hasOwn(environment, key)) values[key] = environment[key];
	}
	const payload = `${JSON.stringify(Object.fromEntries(Object.entries(values).sort()))}\n`;
	const digest = createHash("sha256").update(payload).digest("hex");
	const path = join(home, ".clawdi", "runtime-credentials", `openclaw-${digest}.json`);
	writePrivateFileAtomic(path, payload, { mode: 0o600, dirMode: 0o700, trustedRoot: home });
	const secrets = recordValue(patch.secrets) ?? {};
	patch.secrets = {
		...secrets,
		providers: {
			...recordValue(secrets.providers),
			[OPENCLAW_FILE_SECRET_PROVIDER]: { source: "file", path, mode: "json" },
		},
	};
	return JSON.stringify(patch);
}

/** Environment keys now consumed through file refs, rather than process env. */
export function openClawFileSecretEnvironmentKeys(home: string): Set<string> {
	const keys = new Set<string>();
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const child of value) visit(child);
			return;
		}
		if (!isPlainRecord(value)) return;
		if (
			value.source === "file" &&
			value.provider === OPENCLAW_FILE_SECRET_PROVIDER &&
			typeof value.id === "string" &&
			/^\/[A-Z_][A-Z0-9_]*$/.test(value.id)
		) {
			keys.add(value.id.slice(1));
		}
		for (const child of Object.values(value)) visit(child);
	};
	visit(readPlainOpenClawConfig(join(home, ".openclaw", "openclaw.json")));
	return keys;
}

const MANAGED_CREDENTIAL_FILE = /^openclaw-[a-f0-9]{64}\.json$/;

function managedCredentialReferences(path: string, directory: string): string[] {
	const result = new Set<string>();
	visitOpenClawConfigDocuments(path, (value) => {
		if (
			value.source === "file" &&
			typeof value.path === "string" &&
			value.path === join(directory, basename(value.path)) &&
			MANAGED_CREDENTIAL_FILE.test(basename(value.path))
		)
			result.add(basename(value.path));
	});
	return [...result].sort();
}

/** Capture the old generation before installers or config writers can replace it. */
export function openClawCredentialGeneration(home: string): string[] {
	const directory = join(home, ".clawdi", "runtime-credentials");
	if (!existsSync(directory)) return [];
	return managedCredentialReferences(join(home, ".openclaw", "openclaw.json"), directory);
}

/** Post-apply GC keeps native rollback references and two successful generations. */
export function gcOpenClawFileSecrets(
	home: string,
	previousGeneration: readonly string[] = [],
): void {
	const directory = join(home, ".clawdi", "runtime-credentials");
	if (!existsSync(directory)) return;
	const fd = openTrustedDirectory(directory);
	const pinned = `/proc/self/fd/${fd}`;
	try {
		const configPath = join(home, ".openclaw", "openclaw.json");
		const current = managedCredentialReferences(configPath, directory);
		const keep = new Set(current);
		// Upstream CONFIG_BACKUP_COUNT=5; .pre-update is outside that ring.
		for (const suffix of [".bak", ".bak.1", ".bak.2", ".bak.3", ".bak.4", ".pre-update"]) {
			const path = configPath + suffix;
			if (existsSync(path))
				for (const name of managedCredentialReferences(path, directory)) keep.add(name);
		}
		const files = readdirSync(pinned)
			.filter((name) => MANAGED_CREDENTIAL_FILE.test(name))
			.map((name) => {
				const stat = lstatSync(join(pinned, name));
				if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.geteuid?.())
					throw new Error("Managed OpenClaw credentials have unsafe file identity");
				return name;
			});
		const generationsPath = join(directory, "openclaw-generations.json");
		let previous: string[];
		if (existsSync(generationsPath)) {
			const evidence = readPrivateFileEvidence(generationsPath, {
				uid: process.geteuid?.() ?? 0,
				gid: process.getegid?.() ?? 0,
				modes: [0o600],
				maxBytes: 64 * 1024,
			});
			let generations: unknown;
			try {
				generations = JSON.parse(evidence.content.toString("utf8"));
				evidence.assertCurrent();
			} finally {
				evidence.close();
			}
			if (
				!Array.isArray(generations) ||
				generations.length > 2 ||
				generations.some(
					(generation) =>
						!Array.isArray(generation) ||
						generation.some(
							(name) => typeof name !== "string" || !MANAGED_CREDENTIAL_FILE.test(name),
						),
				)
			)
				throw new Error("Invalid credential generation record");
			previous =
				JSON.stringify(current) === JSON.stringify(generations[0])
					? (generations[1] ?? [])
					: (generations[0] ?? []);
		} else {
			// Upgrade: the pre-apply config, never intermediate or failed candidate files.
			previous = [...previousGeneration];
		}
		for (const name of previous) keep.add(name);
		assertDirectoryIdentity(directory, fd);
		writePrivateFileAtomic(generationsPath, `${JSON.stringify([current, previous])}\n`, {
			directoryFd: fd,
			mode: 0o600,
		});
		for (const name of files) {
			if (keep.has(name)) continue;
			assertDirectoryIdentity(directory, fd);
			unlinkSync(join(pinned, name));
		}
	} finally {
		closeSync(fd);
	}
}
