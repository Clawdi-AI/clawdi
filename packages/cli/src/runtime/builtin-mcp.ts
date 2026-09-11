import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import BUILTIN_MCP_SOURCE from "../../runtime-mcp/index.js" with { type: "text" };
import { SYSTEM_CA_BUNDLE } from "./egress-env";
import { managedMcpHeaderPlaceholder } from "./hosted-egress-profiles";
import type { RuntimeManifest } from "./manifest-contract";
import type { HostedMcpServerDesiredState } from "./manifest-resources";
import type { RuntimePaths } from "./paths";
import { spawnRuntimeUserCommand } from "./runtime-user-command";

export interface BuiltinMcpPackage {
	directory: string;
	files: Record<string, string>;
	server: { command: string; args: string[]; env: Record<string, string> };
}

export function planBuiltinMcp(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	desired: HostedMcpServerDesiredState,
	workspace: string,
): BuiltinMcpPackage {
	const authorization = desired.headers.Authorization;
	if (
		new URL(desired.url).pathname !== "/v1/mcp/clawdi" ||
		Object.keys(desired.headers).length !== 1 ||
		typeof authorization !== "object" ||
		authorization.secretRef !== "secret://clawdi/auth-token" ||
		authorization.prefix !== "Bearer "
	) {
		throw new Error("Built-in local MCP requires the authenticated Clawdi MCP endpoint.");
	}
	const files = {
		"index.mjs": BUILTIN_MCP_SOURCE,
		"context.json": JSON.stringify({
			apiUrl: new URL(desired.url).origin,
			agentId: manifest.environmentId,
			root: workspace,
			authorization: `Bearer ${managedMcpHeaderPlaceholder("clawdi", "Authorization")}`,
		}),
	};
	const digest = createHash("sha256").update(JSON.stringify(files)).digest("hex");
	const directory = join(dirname(paths.serviceStateRoot), "clawdi-mcp", digest);
	return {
		directory,
		files,
		server: {
			command: "/usr/local/bin/node",
			env: { NODE_EXTRA_CA_CERTS: SYSTEM_CA_BUNDLE },
			args: [join(directory, "index.mjs"), "--config", join(directory, "context.json")],
		},
	};
}

/** Root-owned, content-addressed artifacts are readable by the tenant; no credentials are copied. */
export function installBuiltinMcp(plan: BuiltinMcpPackage): void {
	const parent = dirname(plan.directory);
	mkdirSync(parent, { recursive: true, mode: 0o755 });
	const stat = lstatSync(parent);
	if (
		realpathSync(parent) !== parent ||
		stat.uid !== process.geteuid?.() ||
		(stat.mode & 0o022) !== 0
	) {
		throw new Error("Standalone MCP package directory is not administrator-owned.");
	}
	if (existsSync(plan.directory)) {
		const directory = lstatSync(plan.directory);
		if (!directory.isDirectory() || directory.uid !== stat.uid || (directory.mode & 0o022) !== 0)
			throw new Error("Unsafe MCP package directory.");
		for (const [name, content] of Object.entries(plan.files)) {
			const path = join(plan.directory, name);
			const entry = lstatSync(path);
			if (
				!entry.isFile() ||
				entry.uid !== stat.uid ||
				(entry.mode & 0o022) !== 0 ||
				readFileSync(path, "utf8") !== content
			)
				throw new Error("Standalone MCP package integrity mismatch.");
		}
		return;
	}
	const staging = mkdtempSync(join(parent, ".install-"));
	try {
		for (const [name, content] of Object.entries(plan.files))
			writeFileSync(join(staging, name), content, { mode: 0o644, flag: "wx" });
		chmodSync(staging, 0o755);
		renameSync(staging, plan.directory);
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

/** Use the native runtime's tenant identity, not the administrator's access. */
export function verifyBuiltinMcpAccess(
	plan: BuiltinMcpPackage,
	home: string,
	workspace: string,
): void {
	const result = spawnRuntimeUserCommand(
		plan.server.command,
		[
			"--input-type=module",
			"-e",
			'import { accessSync, constants } from "node:fs"; if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1); for (const path of process.argv.slice(1)) accessSync(path, constants.R_OK);',
			...Object.keys(plan.files).map((name) => join(plan.directory, name)),
		],
		home,
		workspace,
		{ timeoutMs: 5_000 },
	);
	if (result.status !== 0)
		throw new Error(
			"Tenant MCP requires Node 24 and readable package files through traversable ancestors.",
		);
}
