import { isAbsolute, join } from "node:path";
import { executableExists, spawnRuntimeUserCommand } from "./runtime-user-command";

const RESOLVE_TIMEOUT_MS = 30_000;
const RESOLVE_MAX_BUFFER_BYTES = 64 * 1024;

// Upstream's read-only generation selection; it imports only stdlib and hermes_constants.
const COMMITTED_VENV_PYTHON = `
import sys
from pathlib import Path
root = sys.argv[1]
sys.path.insert(0, root)
from pm.environments import committed_venv, venv_python
venv = committed_venv(Path(root))
print(venv_python(venv) if venv else "")
`;

/**
 * Interpreter of Hermes' managed dependency environment.
 *
 * Installs predating Hermes' package manager keep `venv` inside the app tree. Package-manager
 * installs commit dependency generations under `~/.hermes/installs` and delete that in-tree venv;
 * their store Python, published through `hermes --print-runtime-command`, selects the committed
 * generation.
 */
export function hermesManagedPython(home: string): string {
	const appRoot = join(home, ".hermes", "hermes-agent");
	const inTree = join(appRoot, "venv", "bin", "python");
	if (executableExists(inTree)) return inTree;
	const storePython = hermesStorePython(home);
	const result = spawnRuntimeUserCommand(
		storePython,
		["-I", "-c", COMMITTED_VENV_PYTHON, appRoot],
		home,
		home,
		{
			environmentOverrides: { HERMES_HOME: join(home, ".hermes") },
			timeoutMs: RESOLVE_TIMEOUT_MS,
			maxBufferBytes: RESOLVE_MAX_BUFFER_BYTES,
		},
	);
	const python = result.status === 0 ? String(result.stdout).trim() : "";
	if (!isAbsolute(python) || !executableExists(python)) {
		throw new Error(`Hermes has no committed Python environment for ${appRoot}`);
	}
	return python;
}

function hermesStorePython(home: string): string {
	const launcher = join(home, ".local", "bin", "hermes");
	if (!executableExists(launcher)) {
		throw new Error(`Hermes launcher is missing: ${launcher}`);
	}
	const result = spawnRuntimeUserCommand(launcher, ["--print-runtime-command"], home, home, {
		timeoutMs: RESOLVE_TIMEOUT_MS,
		maxBufferBytes: RESOLVE_MAX_BUFFER_BYTES,
	});
	let command: unknown = null;
	if (result.status === 0) {
		try {
			command = JSON.parse(String(result.stdout));
		} catch {
			command = null;
		}
	}
	const python = Array.isArray(command) ? command[0] : null;
	if (typeof python !== "string" || !isAbsolute(python) || !executableExists(python)) {
		throw new Error("Hermes launcher did not publish its runtime Python");
	}
	return python;
}
