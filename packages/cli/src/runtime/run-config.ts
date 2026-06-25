import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { writePrivateFileAtomic } from "../lib/private-file";
import { buildMitmBrokerEnv } from "./mitm-env";
import type { RuntimePaths } from "./paths";
import { getRuntimePaths } from "./paths";

const supportedRuntimeSchema = z.enum(["hermes", "openclaw"]);
export type SupportedRuntimeName = z.infer<typeof supportedRuntimeSchema>;

const envKeySchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

export const runtimeRunSettingsSchema = z
	.object({
		command: z.string().min(1).optional(),
		args: z.array(z.string()).default([]),
		env: z.record(envKeySchema, z.string()).default({}),
		cwd: z.string().min(1).optional(),
		prependPath: z.array(z.string().min(1)).default([]),
	})
	.strict();

export type RuntimeRunSettings = z.infer<typeof runtimeRunSettingsSchema>;

const runtimeRunConfigSchema = z
	.object({
		schemaVersion: z.literal("clawdi.runtimeRunConfig.v1"),
		runtime: supportedRuntimeSchema,
		enabled: z.boolean(),
		generatedAt: z.string().min(1),
		generation: z.number().int().nonnegative(),
		instanceId: z.string().min(1),
		command: z.string().min(1),
		defaultArgs: z.array(z.string()).default([]),
		env: z.record(envKeySchema, z.string()).default({}),
		secretFilePath: z.string().min(1).nullable().default(null),
		prependPath: z.array(z.string().min(1)).default([]),
		cwd: z.string().min(1).optional(),
		commandPath: z.string().min(1).nullable(),
		appRoot: z.string().min(1).nullable(),
		mitmProfileBundlePath: z.string().min(1).nullable().default(null),
	})
	.strict();

export type RuntimeRunConfig = z.infer<typeof runtimeRunConfigSchema>;

const DEFAULT_RUNTIME_ARGS: Record<SupportedRuntimeName, string[]> = {
	hermes: ["dashboard", "--host", "127.0.0.1", "--no-open"],
	openclaw: [
		"gateway",
		"run",
		"--allow-unconfigured",
		"--auth",
		"none",
		"--bind",
		"loopback",
		"--force",
	],
};

export type RuntimeRunConfigRead =
	| { status: "not-runtime"; runtime: null }
	| { status: "missing"; runtime: SupportedRuntimeName; path: string }
	| { status: "invalid"; runtime: SupportedRuntimeName; path: string; error: string }
	| { status: "disabled"; runtime: SupportedRuntimeName; path: string; config: RuntimeRunConfig }
	| { status: "ok"; runtime: SupportedRuntimeName; path: string; config: RuntimeRunConfig };

export interface RuntimeRunInvocation {
	runtime: string;
	command: string;
	args: string[];
	cwd?: string;
	env: NodeJS.ProcessEnv;
	configPath: string;
}

export function runtimeNameForCommand(command: string): SupportedRuntimeName | null {
	const name = basename(command);
	const parsed = supportedRuntimeSchema.safeParse(name);
	return parsed.success ? parsed.data : null;
}

export function runtimeRunConfigPath(
	runtime: SupportedRuntimeName,
	paths = getRuntimePaths(),
): string {
	return join(paths.runConfigRoot, `${runtime}.json`);
}

export function buildRuntimeRunConfig(input: {
	runtime: SupportedRuntimeName;
	enabled: boolean;
	generatedAt: string;
	generation: number;
	instanceId: string;
	commandPath: string | null;
	appRoot: string | null;
	workspaceRoot: string;
	mitmProfileBundlePath?: string | null;
	settings?: RuntimeRunSettings;
	secretFilePath?: string | null;
}): RuntimeRunConfig {
	const defaultPath = input.commandPath ? [dirname(input.commandPath)] : [];
	const prependPath = [...defaultPath, ...(input.settings?.prependPath ?? [])].filter(
		(value, index, values) => values.indexOf(value) === index,
	);
	return {
		schemaVersion: "clawdi.runtimeRunConfig.v1",
		runtime: input.runtime,
		enabled: input.enabled,
		generatedAt: input.generatedAt,
		generation: input.generation,
		instanceId: input.instanceId,
		command: input.settings?.command ?? input.commandPath ?? input.runtime,
		defaultArgs: input.settings?.args ?? DEFAULT_RUNTIME_ARGS[input.runtime],
		env: input.settings?.env ?? {},
		secretFilePath: input.secretFilePath ?? null,
		prependPath,
		cwd: input.settings?.cwd ?? input.workspaceRoot,
		commandPath: input.commandPath,
		appRoot: input.appRoot,
		mitmProfileBundlePath: input.mitmProfileBundlePath ?? null,
	};
}

export function writeRuntimeRunConfig(config: RuntimeRunConfig, paths: RuntimePaths): string {
	const path = runtimeRunConfigPath(config.runtime, paths);
	writePrivateFileAtomic(path, `${JSON.stringify(config, null, 2)}\n`, {
		mode: 0o644,
		dirMode: 0o755,
	});
	return path;
}

export function readRuntimeRunConfigForCommand(
	command: string,
	paths = getRuntimePaths(),
): RuntimeRunConfigRead {
	const runtime = runtimeNameForCommand(command);
	if (!runtime) return { status: "not-runtime", runtime: null };

	const path = runtimeRunConfigPath(runtime, paths);
	if (!existsSync(path)) return { status: "missing", runtime, path };

	try {
		const parsed = runtimeRunConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
		if (!parsed.enabled) return { status: "disabled", runtime, path, config: parsed };
		return { status: "ok", runtime, path, config: parsed };
	} catch (error) {
		return {
			status: "invalid",
			runtime,
			path,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function buildRuntimeRunInvocation(
	read: Extract<RuntimeRunConfigRead, { status: "ok" }>,
	args: string[],
	baseEnv: NodeJS.ProcessEnv,
): RuntimeRunInvocation {
	const pathPrefix = read.config.prependPath.join(":");
	const currentPath = baseEnv.PATH ?? "";
	const env = {
		...baseEnv,
		...read.config.env,
		...(read.config.secretFilePath ? { CLAWDI_MITM_SECRET_FILE: read.config.secretFilePath } : {}),
		PATH: pathPrefix ? [pathPrefix, currentPath].filter(Boolean).join(":") : currentPath,
	};
	const brokerEnv = buildMitmBrokerEnv({
		env,
		profileBundlePath: read.config.mitmProfileBundlePath,
	});
	const command =
		read.config.commandPath && existsSync(read.config.commandPath)
			? read.config.commandPath
			: read.config.command;
	return {
		runtime: read.runtime,
		command,
		args: [...read.config.defaultArgs, ...args.slice(1)],
		cwd: read.config.cwd,
		env: brokerEnv,
		configPath: read.path,
	};
}
