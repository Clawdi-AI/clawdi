import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { writePrivateFileAtomic } from "../lib/private-file";
import { applyMitmTransparentRuntimeEnv } from "./mitm-env";
import type { RuntimePaths } from "./paths";
import { getRuntimePaths } from "./paths";
import { runtimeSecretValue } from "./secret-values";

export const runtimeNameSchema = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
	.refine((name) => name !== "clawdi", "Runtime name is reserved.");
export type RuntimeName = z.infer<typeof runtimeNameSchema>;

export const runtimeServiceNameSchema = z
	.string()
	.regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
	.refine((name) => name !== "main", "Runtime service name is reserved.");
export type RuntimeServiceName = z.infer<typeof runtimeServiceNameSchema>;

const supportedRuntimeSchema = z.enum(["hermes", "openclaw"]);
export type SupportedRuntimeName = z.infer<typeof supportedRuntimeSchema>;

const envKeySchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

export const runtimeRunSettingsSchema = z.object({
	command: z.string().min(1).optional(),
	args: z.array(z.string()).optional(),
	env: z.record(envKeySchema, z.string()).default({}),
	secretEnv: z.record(envKeySchema, z.string().min(1)).optional(),
	cwd: z.string().min(1).optional(),
	prependPath: z.array(z.string().min(1)).default([]),
});

export type RuntimeRunSettings = z.infer<typeof runtimeRunSettingsSchema>;

const runtimeRunConfigSchema = z
	.object({
		schemaVersion: z.literal("clawdi.runtimeRunConfig.v1"),
		runtime: runtimeNameSchema,
		service: runtimeServiceNameSchema.nullable().default(null),
		enabled: z.boolean(),
		generatedAt: z.string().min(1),
		generation: z.number().int().nonnegative(),
		instanceId: z.string().min(1),
		command: z.string().min(1),
		defaultArgs: z.array(z.string()).default([]),
		env: z.record(envKeySchema, z.string()).default({}),
		secretEnv: z.record(envKeySchema, z.string().min(1)).default({}),
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
	openclaw: ["gateway", "run", "--allow-unconfigured", "--bind", "loopback", "--force"],
};

export type RuntimeRunConfigRead =
	| { status: "not-runtime"; runtime: null }
	| { status: "missing"; runtime: RuntimeName; path: string }
	| { status: "invalid"; runtime: RuntimeName; path: string; error: string }
	| { status: "disabled"; runtime: RuntimeName; path: string; config: RuntimeRunConfig }
	| { status: "ok"; runtime: RuntimeName; path: string; config: RuntimeRunConfig };

export interface RuntimeRunInvocation {
	runtime: string;
	service: string | null;
	command: string;
	args: string[];
	cwd?: string;
	env: NodeJS.ProcessEnv;
	configPath: string;
}

export function isSupportedRuntimeName(name: string): name is SupportedRuntimeName {
	return supportedRuntimeSchema.safeParse(name).success;
}

export function runtimeNameForCommand(command: string): RuntimeName | null {
	const name = basename(command);
	const parsed = runtimeNameSchema.safeParse(name);
	return parsed.success ? parsed.data : null;
}

export function runtimeRunConfigId(
	runtime: RuntimeName,
	service?: RuntimeServiceName | null,
): string {
	return service ? `${runtime}+${service}` : runtime;
}

export function runtimeRunConfigPath(
	runtime: RuntimeName,
	paths = getRuntimePaths(),
	service?: RuntimeServiceName | null,
): string {
	return join(paths.runConfigRoot, `${runtimeRunConfigId(runtime, service)}.json`);
}

export function buildRuntimeRunConfig(input: {
	runtime: RuntimeName;
	service?: RuntimeServiceName | null;
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
	secretEnv?: Record<string, string>;
}): RuntimeRunConfig {
	const defaultPath = input.commandPath ? [dirname(input.commandPath)] : [];
	const prependPath = [...defaultPath, ...(input.settings?.prependPath ?? [])].filter(
		(value, index, values) => values.indexOf(value) === index,
	);
	return {
		schemaVersion: "clawdi.runtimeRunConfig.v1",
		runtime: input.runtime,
		service: input.service ?? null,
		enabled: input.enabled,
		generatedAt: input.generatedAt,
		generation: input.generation,
		instanceId: input.instanceId,
		command: input.settings?.command ?? input.commandPath ?? input.runtime,
		defaultArgs: input.settings?.args ?? (input.service ? [] : defaultRuntimeArgs(input.runtime)),
		env: input.settings?.env ?? {},
		secretEnv: input.secretEnv ?? {},
		secretFilePath: input.secretFilePath ?? null,
		prependPath,
		cwd: input.settings?.cwd ?? input.workspaceRoot,
		commandPath: input.commandPath,
		appRoot: input.appRoot,
		mitmProfileBundlePath: input.mitmProfileBundlePath ?? null,
	};
}

export function writeRuntimeRunConfig(config: RuntimeRunConfig, paths: RuntimePaths): string {
	const path = runtimeRunConfigPath(config.runtime, paths, config.service);
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
	if (!existsSync(path)) {
		return isSupportedRuntimeName(runtime)
			? { status: "missing", runtime, path }
			: { status: "not-runtime", runtime: null };
	}

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

export function readRuntimeServiceRunConfig(
	runtime: string,
	service: string,
	paths = getRuntimePaths(),
): RuntimeRunConfigRead {
	const parsedRuntime = runtimeNameSchema.safeParse(runtime);
	if (!parsedRuntime.success) return { status: "not-runtime", runtime: null };
	const parsedService = runtimeServiceNameSchema.safeParse(service);
	if (!parsedService.success) return { status: "not-runtime", runtime: null };

	const path = runtimeRunConfigPath(parsedRuntime.data, paths, parsedService.data);
	if (!existsSync(path)) {
		return { status: "missing", runtime: parsedRuntime.data, path };
	}

	try {
		const parsed = runtimeRunConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
		if (!parsed.enabled)
			return { status: "disabled", runtime: parsedRuntime.data, path, config: parsed };
		return { status: "ok", runtime: parsedRuntime.data, path, config: parsed };
	} catch (error) {
		return {
			status: "invalid",
			runtime: parsedRuntime.data,
			path,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function buildRuntimeRunInvocation(
	read: Extract<RuntimeRunConfigRead, { status: "ok" }>,
	args: string[],
	baseEnv: NodeJS.ProcessEnv,
	paths = getRuntimePaths(),
): RuntimeRunInvocation {
	const pathPrefix = read.config.prependPath.join(":");
	const currentPath = withoutPathEntry(baseEnv.PATH ?? "", runtimeManagedBinDir(paths));
	const env = {
		...baseEnv,
		...read.config.env,
		...runtimeSecretEnv(read.config.secretFilePath, read.config.secretEnv),
		...(read.config.secretFilePath && read.config.mitmProfileBundlePath
			? { CLAWDI_MITM_SECRET_FILE: read.config.secretFilePath }
			: {}),
		PATH: pathPrefix ? [pathPrefix, currentPath].filter(Boolean).join(":") : currentPath,
	};
	if (read.config.mitmProfileBundlePath) {
		applyMitmTransparentRuntimeEnv(env);
	}
	const command =
		read.config.commandPath && existsSync(read.config.commandPath)
			? read.config.commandPath
			: read.config.command;
	return {
		runtime: read.runtime,
		service: read.config.service,
		command,
		args: args.length > 1 ? args.slice(1) : read.config.defaultArgs,
		cwd: read.config.cwd,
		env,
		configPath: read.path,
	};
}

export function runtimeManagedBinDir(paths = getRuntimePaths()): string {
	return join(paths.serviceStateRoot, "bin");
}

export function withoutPathEntry(path: string, entry: string): string {
	return path
		.split(":")
		.filter((part) => part && part !== entry)
		.join(":");
}

function defaultRuntimeArgs(runtime: RuntimeName): string[] {
	const parsed = supportedRuntimeSchema.safeParse(runtime);
	return parsed.success ? DEFAULT_RUNTIME_ARGS[parsed.data] : [];
}

function runtimeSecretEnv(
	secretFilePath: string | null,
	secretEnv: Record<string, string>,
): Record<string, string> {
	const entries = Object.entries(secretEnv);
	if (entries.length === 0) return {};
	const fileBackedEntries = entries.filter(([, ref]) => !ref.startsWith("env://"));
	if (fileBackedEntries.length > 0 && !secretFilePath) {
		throw new Error("Runtime run config references secrets but has no secret file.");
	}
	let secrets: Record<string, unknown> = {};
	if (fileBackedEntries.length > 0 && secretFilePath) {
		let rawSecrets: unknown;
		try {
			rawSecrets = JSON.parse(readFileSync(secretFilePath, "utf-8"));
		} catch (error) {
			throw new Error(
				`Runtime secret file is unavailable: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (!rawSecrets || typeof rawSecrets !== "object" || Array.isArray(rawSecrets)) {
			throw new Error("Runtime secret file must contain a JSON object.");
		}
		secrets = rawSecrets as Record<string, unknown>;
	}
	const env: Record<string, string> = {};
	for (const [envName, ref] of entries) {
		const value = runtimeSecretValue(secrets, ref);
		if (!value) {
			throw new Error(`Runtime secret ${ref} for ${envName} is unavailable.`);
		}
		env[envName] = value;
	}
	return env;
}
