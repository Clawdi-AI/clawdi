import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentAdapterCore } from "./base";
import { getDshHome } from "./paths";
import { flatSkillModule } from "./skill-dir";
import { readCommandVersion } from "./version";

/** DeepSeek Harness P0: local identity and directory Skills only. */
export class DshAdapter implements AgentAdapterCore {
	readonly agentType = "dsh" as const;
	readonly skills = flatSkillModule({ root: () => join(getDshHome(), "skills") });

	async detect(): Promise<boolean> {
		return existsSync(getDshHome());
	}

	async getVersion(): Promise<string | null> {
		return readCommandVersion("dsh", ["--version"]);
	}
}
