import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFileAtomic } from "../lib/private-file";
import { isPlainRecord, recordValue } from "./manifest-shared";

export const OPENCLAW_FILE_SECRET_PROVIDER = "clawdi-runtime";

/**
 * Project only API-key references owned by this provider patch. The versioned
 * path makes a key rotation a config change, so OpenClaw reloads the file in the
 * same transaction as the models, without an authenticated secrets.reload RPC.
 * Called under the runtime filesystem identity; directories are 0700, files 0600.
 */
export function projectOpenClawProviderFileSecrets(
	content: string,
	environment: Record<string, string>,
	home: string,
): string {
	const patch = recordValue(JSON.parse(content) as unknown);
	if (!patch) throw new Error("OpenClaw provider patch must be an object");
	const values: Record<string, string> = {};
	const project = (value: unknown): void => {
		if (!isPlainRecord(value)) return;
		for (const [key, child] of Object.entries(value)) {
			if (
				isPlainRecord(child) &&
				child.source === "env" &&
				typeof child.id === "string" &&
				Object.hasOwn(environment, child.id)
			) {
				values[child.id] = environment[child.id];
				value[key] = {
					source: "file",
					provider: OPENCLAW_FILE_SECRET_PROVIDER,
					id: `/${child.id}`,
				};
			} else project(child);
		}
	};
	project(patch);
	if (Object.keys(values).length === 0) return content;
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
	try {
		visit(JSON.parse(readFileSync(join(home, ".openclaw", "openclaw.json"), "utf8")) as unknown);
	} catch {
		// Missing/unreadable config is not evidence that an environment key is unused.
	}
	return keys;
}
