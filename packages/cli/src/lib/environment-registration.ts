import { join } from "node:path";
import type { AgentType } from "../adapters/registry";
import { getClawdiDir } from "./config";
import { withPrivateDirectoryLockSync } from "./private-directory-lock";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, writePrivateFileAtomic } from "./private-file";

interface EnvironmentRegistration {
	id: string;
	agentType: AgentType;
	machineId: string;
	machineName: string;
	userId?: string;
}

export function writeEnvironmentRegistration(registration: EnvironmentRegistration): void {
	const clawdiDir = getClawdiDir();
	withPrivateDirectoryLockSync(join(clawdiDir, "environments.lock"), (lease) => {
		const path = join(clawdiDir, "environments", `${registration.agentType}.json`);
		lease.assertOwned();
		writePrivateFileAtomic(path, `${JSON.stringify(registration, null, 2)}\n`, {
			mode: PRIVATE_FILE_MODE,
			dirMode: PRIVATE_DIR_MODE,
			durable: true,
		});
	});
}
