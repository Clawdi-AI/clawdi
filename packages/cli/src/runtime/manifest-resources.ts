import { z } from "zod";
import { hasAsciiControlCharacter } from "../lib/github-skill-archive";
import { secretRefSchema } from "./egress-profiles";

const managedEntryNameSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const mcpHeaderNameSchema = z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/);

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

export const hostedSkillSourceSchema = z
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
