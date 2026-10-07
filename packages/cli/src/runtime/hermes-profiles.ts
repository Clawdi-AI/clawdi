import { join } from "node:path";
import { HERMES_PROFILE_DISCOVERY, hermesProfileSchema } from "../adapters/profiles";
import { hermesManagedPython } from "./hermes-python";
import { runtimeAppRoot } from "./manifest-install";
import { spawnRuntimeUserCommand } from "./runtime-user-command";

/** Synchronous upstream discovery for runtime convergence, independent of the active profile. */
export function listHermesProfileNames(home: string): string[] {
	const appRoot = runtimeAppRoot("hermes", home);
	if (!appRoot) throw new Error("app_root_unavailable");
	let python: string;
	try {
		python = hermesManagedPython(home);
	} catch {
		throw new Error("runtime_python_unavailable");
	}
	const result = spawnRuntimeUserCommand(
		python,
		["-c", HERMES_PROFILE_DISCOVERY, appRoot],
		home,
		home,
		{
			environmentOverrides: {
				HERMES_HOME: join(home, ".hermes"),
				HERMES_PROFILE: "",
				HERMES_PROFILE_NAME: "",
			},
			timeoutMs: 30_000,
			maxBufferBytes: 1024 * 1024,
		},
	);
	if (result.status !== 0 || result.error) throw new Error("upstream_discovery_failed");
	let rows: unknown;
	try {
		rows = JSON.parse(String(result.stdout));
	} catch {
		throw new Error("upstream_output_invalid");
	}
	if (!Array.isArray(rows)) throw new Error("upstream_output_invalid");
	const names = rows.flatMap((row) => {
		const parsed = hermesProfileSchema.safeParse(row);
		return parsed.success && !parsed.data.failed ? [parsed.data.name] : [];
	});
	if (!names.includes("default")) throw new Error("default_profile_missing");
	return names;
}
