import { z } from "zod";
import { secretRefSchema } from "./egress-profiles";

const managedEntryNameSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const mcpHeaderNameSchema = z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/);

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

export const hostedSkillEntryDesiredStateSchema = z
	.object({
		enabled: z.boolean(),
	})
	.strict();

export const hostedSkillsDesiredStateSchema = z
	.object({
		entries: z.record(managedEntryNameSchema, hostedSkillEntryDesiredStateSchema),
	})
	.strict();
