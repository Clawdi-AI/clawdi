import { z } from "zod";
import { hasAsciiControlCharacter } from "../lib/github-skill-archive";
import { secretRefSchema } from "./egress-profiles";

const managedEntryNameSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const agentPluginNameSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
const mcpHeaderNameSchema = z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/);

export const AGENT_PLUGINS_SCHEMA_1_0_0 =
	"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

function isMcpCredentialHeader(name: string): boolean {
	const normalized = name.toLowerCase();
	if (["authorization", "proxy-authorization", "cookie"].includes(normalized)) return true;
	return /(?:^|[-_])(?:api[-_]?key|apikey|tokens?|secrets?|credentials?)(?:$|[-_])/.test(
		normalized,
	);
}

const mcpSecretHeaderSchema = z
	.object({
		secretRef: secretRefSchema,
		prefix: z.string().max(100).default(""),
	})
	.strict();

const hostedStdioMcpServerDesiredStateSchema = z
	.object({
		command: z
			.string()
			.min(1)
			.max(200)
			.refine((value) => value === value.trim(), "command must not have surrounding whitespace"),
		args: z
			.array(
				z
					.string()
					.min(1)
					.refine((value) => value === value.trim(), "args must be canonical strings"),
			)
			.max(32),
	})
	.strict();

const hostedRemoteMcpServerDesiredStateSchema = z
	.object({
		url: z
			.string()
			.url()
			.refine((value) => {
				const url = new URL(value);
				return (
					(url.protocol === "http:" || url.protocol === "https:") &&
					!url.username &&
					!url.password &&
					!url.search &&
					!url.hash
				);
			}, "must be an HTTP(S) URL without credentials, query, or fragment"),
		transport: z.enum(["streamable-http", "sse"]),
		headers: z
			.record(mcpHeaderNameSchema, z.union([z.string(), mcpSecretHeaderSchema]))
			.default({}),
	})
	.strict()
	.superRefine((server, ctx) => {
		const seen = new Set<string>();
		for (const header of Object.keys(server.headers)) {
			const normalized = header.toLowerCase();
			if (seen.has(normalized)) {
				ctx.addIssue({
					code: "custom",
					message: `duplicate HTTP header ${header}`,
					path: ["headers", header],
				});
			}
			if (typeof server.headers[header] === "string" && isMcpCredentialHeader(header)) {
				ctx.addIssue({
					code: "custom",
					message: `credential-bearing HTTP header ${header} must use secretRef`,
					path: ["headers", header],
				});
			}
			seen.add(normalized);
		}
	});

export const hostedMcpServerDesiredStateSchema = z.union([
	hostedStdioMcpServerDesiredStateSchema,
	hostedRemoteMcpServerDesiredStateSchema,
]);
export type HostedMcpServerDesiredState = z.infer<typeof hostedMcpServerDesiredStateSchema>;

export const hostedMcpDesiredStateSchema = z
	.object({
		servers: z.record(managedEntryNameSchema, hostedMcpServerDesiredStateSchema),
	})
	.strict();

const exactGitCommitSchema = z.string().regex(/^[a-f0-9]{40}$/);

function isCanonicalGithubRepositoryUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			url.hostname === "github.com" &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash &&
			/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(url.pathname)
		);
	} catch {
		return false;
	}
}

function isSafeRepositoryPath(value: string): boolean {
	if (value === "") return true;
	const segments = value.split("/");
	return (
		value === value.trim() &&
		segments.length > 0 &&
		segments.every(
			(segment) =>
				segment.length > 0 &&
				segment !== "." &&
				segment !== ".." &&
				!segment.includes("\\") &&
				!hasAsciiControlCharacter(segment),
		)
	);
}

const hostedGithubSkillSourceSchema = z
	.object({
		type: z.literal("github"),
		url: z
			.string()
			.max(500)
			.refine(isCanonicalGithubRepositoryUrl, "must be a canonical GitHub repository URL"),
		path: z
			.string()
			.max(500)
			.refine(isSafeRepositoryPath, "must be a safe repository-relative directory"),
		commit: exactGitCommitSchema,
	})
	.strict();

const exactAgentPluginSemverSchema = z
	.string()
	.min(1)
	.max(100)
	.regex(
		/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
	);

const hostedAgentPluginInstallationSchema = z
	.object({
		installationId: z
			.string()
			.min(1)
			.max(200)
			.refine(
				(value) => value === value.trim() && !hasAsciiControlCharacter(value),
				"must be a canonical non-empty identifier",
			),
		version: exactAgentPluginSemverSchema,
		agentPluginsSchema: z.literal(AGENT_PLUGINS_SCHEMA_1_0_0),
		source: hostedGithubSkillSourceSchema,
		contentDigest: z.string().regex(/^sha256-tree-v1:[0-9a-f]{64}$/),
		secretRefs: z
			.record(agentPluginNameSchema, secretRefSchema.max(1_000))
			.refine((value) => Object.keys(value).length <= 128, "must contain at most 128 entries"),
	})
	.strict();

export const hostedAgentPluginsDesiredStateSchema = z
	.object({
		schemaVersion: z.literal(1),
		installations: z
			.record(agentPluginNameSchema, hostedAgentPluginInstallationSchema)
			.refine((value) => Object.keys(value).length <= 128, "must contain at most 128 entries"),
	})
	.strict();

export type HostedAgentPluginsDesiredState = z.infer<typeof hostedAgentPluginsDesiredStateSchema>;

const cleanHttpUrlSchema = z
	.string()
	.url()
	.max(2_000)
	.refine((value) => {
		const url = new URL(value);
		return (
			(url.protocol === "https:" || url.protocol === "http:") &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash
		);
	}, "must be a clean HTTP(S) URL");

const hostedProjectSkillSourceSchema = z
	.object({
		type: z.literal("project"),
		projectId: z.uuid(),
		contentHash: z.string().regex(/^[a-f0-9]{64}$/),
		archiveUrl: cleanHttpUrlSchema,
		installUrl: cleanHttpUrlSchema,
	})
	.strict();

export const hostedSkillSourceSchema = z.discriminatedUnion("type", [
	hostedGithubSkillSourceSchema,
	hostedProjectSkillSourceSchema,
]);
export type HostedSkillSource = z.infer<typeof hostedSkillSourceSchema>;

const hostedBundledSkillEntryDesiredStateSchema = z
	.object({
		enabled: z.boolean(),
		// Expand-phase compatibility for enabled-only manifests is pinned to the
		// first immutable bundle. It must never resolve relative to the CLI package.
		version: z.number().int().positive().default(1),
	})
	.strict();

const hostedSourcedSkillEntryDesiredStateSchema = z
	.object({
		enabled: z.boolean(),
		source: hostedSkillSourceSchema,
	})
	.strict();

export const hostedSkillEntryDesiredStateSchema = z.union([
	hostedBundledSkillEntryDesiredStateSchema,
	hostedSourcedSkillEntryDesiredStateSchema,
]);

export const hostedSkillsDesiredStateSchema = z
	.object({
		entries: z.record(managedEntryNameSchema, hostedSkillEntryDesiredStateSchema),
	})
	.strict();
