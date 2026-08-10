import { z } from "zod";

// Cold JSON report shapes at OpenClaw cef6e690d5573d06f3feef5fdf103906e842c618:
// https://github.com/openclaw/openclaw/blob/cef6e690d5573d06f3feef5fdf103906e842c618/src/cli/plugins-inspect-command.ts
// https://github.com/openclaw/openclaw/blob/cef6e690d5573d06f3feef5fdf103906e842c618/src/cli/plugins-list-command.ts
export const openClawPluginInspectSchema = z
	.object({
		plugin: z
			.object({
				id: z.string().min(1),
				name: z.string().min(1).optional(),
				source: z.string().min(1),
				origin: z.enum(["bundled", "global", "workspace", "config"]),
				status: z.enum(["loaded", "disabled", "error"]),
				version: z.string().min(1).optional(),
				enabled: z.boolean(),
				format: z.string().min(1).optional(),
				bundleFormat: z.string().min(1).optional(),
			})
			.passthrough(),
		install: z
			.object({
				source: z.enum(["npm", "archive", "path", "clawhub", "git"]),
				spec: z.string().min(1).optional(),
				sourcePath: z.string().min(1).optional(),
				installPath: z.string().min(1).optional(),
				version: z.string().min(1).optional(),
				resolvedName: z.string().min(1).optional(),
				resolvedVersion: z.string().min(1).optional(),
				resolvedSpec: z.string().min(1).optional(),
				integrity: z.string().min(1).optional(),
				shasum: z.string().min(1).optional(),
				npmIntegrity: z.string().min(1).optional(),
				npmShasum: z.string().min(1).optional(),
				clawpackSha256: z.string().min(1).optional(),
				gitUrl: z.string().min(1).optional(),
				gitRef: z.string().min(1).optional(),
				gitCommit: z.string().min(1).optional(),
			})
			.passthrough(),
	})
	.passthrough();

const openClawMcpServerSchema = z
	.object({
		name: z.string().min(1),
		hasStdioTransport: z.boolean(),
		unsupported: z.boolean().optional(),
	})
	.passthrough();

const openClawPluginDiagnosticSchema = z
	.object({
		level: z.enum(["warn", "error"]),
		message: z.string().min(1),
	})
	.passthrough();

export const openClawAgentPluginInspectSchema = openClawPluginInspectSchema.extend({
	mcpServers: z.array(openClawMcpServerSchema),
	diagnostics: z.array(openClawPluginDiagnosticSchema),
});

export const openClawPluginListSchema = z
	.object({
		plugins: z.array(
			z
				.object({
					id: z.string().min(1),
					name: z.string().min(1).optional(),
					version: z.string().min(1).optional(),
					enabled: z.boolean(),
					status: z.enum(["loaded", "disabled", "error"]),
					format: z.string().min(1).optional(),
					bundleFormat: z.string().min(1).optional(),
				})
				.passthrough(),
		),
	})
	.passthrough();
