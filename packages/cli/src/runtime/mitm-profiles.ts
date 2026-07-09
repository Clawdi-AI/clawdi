import { z } from "zod";
import { writePrivateFileAtomic } from "../lib/private-file";
import type { RuntimePaths } from "./paths";

const secretRefSchema = z
	.string()
	.min(1)
	.regex(/^secret:\/\//);
const profileIdSchema = z
	.string()
	.min(1)
	.regex(/^[a-z0-9][a-z0-9-_.]*$/);
const headerNameSchema = z
	.string()
	.min(1)
	.regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/);
const queryNameSchema = z.string().min(1);

function isSafeMitmHost(host: string): boolean {
	if (!host || host.length > 253) return false;
	for (const char of host) {
		const code = char.charCodeAt(0);
		if (
			char === "@" ||
			char === "?" ||
			char === "#" ||
			char === "/" ||
			char === "\\" ||
			char === " " ||
			char === "%" ||
			code < 0x20 ||
			code === 0x7f
		) {
			return false;
		}
	}
	return !host.startsWith(".") && !host.endsWith(".");
}

function isSafeUpstreamBaseUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return (
			["http:", "https:", "ws:", "wss:"].includes(parsed.protocol) &&
			parsed.username === "" &&
			parsed.password === "" &&
			isSafeMitmHost(parsed.hostname.toLowerCase())
		);
	} catch {
		return false;
	}
}

const headerMatcherSchema = z
	.discriminatedUnion("type", [
		z
			.object({
				type: z.literal("exists"),
			})
			.strict(),
		z
			.object({
				type: z.literal("equals"),
				value: z.string(),
				prefix: z.string().optional(),
			})
			.strict(),
		z
			.object({
				type: z.literal("secretRefEquals"),
				secretRef: secretRefSchema,
				prefix: z.string().optional(),
			})
			.strict(),
	])
	.describe(
		"Header matchers must never inline secret values unless type=equals is intentionally public.",
	);

const pathMatcherSchema = z
	.discriminatedUnion("type", [
		z
			.object({
				type: z.literal("equals"),
				value: z.string().min(1),
			})
			.strict(),
		z
			.object({
				type: z.literal("prefix"),
				value: z.string().min(1),
			})
			.strict(),
		z
			.object({
				type: z.literal("secretRefEquals"),
				secretRef: secretRefSchema,
				prefix: z.string().default(""),
				suffix: z.string().default(""),
			})
			.strict(),
		z
			.object({
				type: z.literal("secretRefPrefix"),
				secretRef: secretRefSchema,
				prefix: z.string().default(""),
				suffix: z.string().default(""),
			})
			.strict(),
	])
	.describe("Path matchers allow URL-embedded tokens such as Telegram Bot API tokens.");

const headerSetterSchema = z
	.union([
		z.string(),
		z
			.object({
				type: z.literal("secretRef"),
				secretRef: secretRefSchema,
				prefix: z.string().default(""),
			})
			.strict(),
	])
	.describe(
		"Rewrite headers can be literal public values or secretRef-backed values resolved only by the sidecar.",
	);

const pathReplaceSchema = z
	.object({
		type: z.literal("secretRefPrefix"),
		secretRef: secretRefSchema,
		replacementSecretRef: secretRefSchema,
		prefix: z.string().default(""),
		suffix: z.string().default(""),
	})
	.strict();

const mitmProfileMatchSchema = z
	.object({
		scheme: z.enum(["http", "https", "ws", "wss"]).optional(),
		host: z.string().min(1),
		pathPrefix: z
			.string()
			.min(1)
			.refine((value) => value.startsWith("/"), "pathPrefix must start with /")
			.optional(),
		path: pathMatcherSchema.optional(),
		headers: z.record(headerNameSchema, headerMatcherSchema).default({}),
		query: z.record(queryNameSchema, headerMatcherSchema).default({}),
	})
	.strict();

const mitmProfileRewriteSchema = z
	.object({
		upstreamBaseUrl: z
			.string()
			.url()
			.refine(
				(value) => ["http:", "https:", "ws:", "wss:"].includes(new URL(value).protocol),
				"upstreamBaseUrl must use http, https, ws, or wss",
			)
			.refine(
				isSafeUpstreamBaseUrl,
				"upstreamBaseUrl must not include credentials or an unsafe host",
			)
			.optional(),
		preservePath: z.boolean().default(true),
		pathReplace: pathReplaceSchema.optional(),
		setHeaders: z.record(headerNameSchema, headerSetterSchema).default({}),
	})
	.strict();

const mitmProfileLoggingSchema = z
	.object({
		redactHeaders: z.array(headerNameSchema).default([]),
		redactUrlPatterns: z.array(z.string().min(1)).default([]),
	})
	.strict();

export const mitmProfileSchema = z
	.object({
		id: profileIdSchema,
		enabled: z.boolean().default(true),
		kind: z.enum(["http", "websocket", "provider", "passthrough", "deny"]),
		match: mitmProfileMatchSchema,
		rewrite: mitmProfileRewriteSchema.optional(),
		logging: mitmProfileLoggingSchema.default({ redactHeaders: [], redactUrlPatterns: [] }),
		priority: z.number().int().default(100),
		owner: z.string().min(1).optional(),
		description: z.string().min(1).optional(),
	})
	.strict()
	.superRefine((profile, ctx) => {
		if (
			(profile.kind === "http" || profile.kind === "websocket") &&
			!profile.rewrite?.upstreamBaseUrl
		) {
			ctx.addIssue({
				code: "custom",
				path: ["rewrite", "upstreamBaseUrl"],
				message: `${profile.kind} profiles require rewrite.upstreamBaseUrl`,
			});
		}
		if (profile.kind === "deny" && profile.rewrite) {
			ctx.addIssue({
				code: "custom",
				path: ["rewrite"],
				message: "deny profiles must not include rewrite rules",
			});
		}
		if (profile.kind === "passthrough" && profile.rewrite) {
			ctx.addIssue({
				code: "custom",
				path: ["rewrite"],
				message: "passthrough profiles must not include rewrite rules",
			});
		}
	});

export const mitmProfileInputBundleSchema = z
	.object({
		profiles: z.array(mitmProfileSchema).default([]),
	})
	.strict();

export const mitmProfileBundleSchema = z
	.object({
		schemaVersion: z.literal("clawdi.mitmProfiles.v1"),
		generatedAt: z.string().min(1),
		generation: z.number().int().nonnegative(),
		instanceId: z.string().min(1),
		profiles: z.array(mitmProfileSchema),
	})
	.strict();

export type MitmProfileInputBundle = z.infer<typeof mitmProfileInputBundleSchema>;
export type MitmProfileBundle = z.infer<typeof mitmProfileBundleSchema>;

export function buildMitmProfileBundle(input: {
	generatedAt: string;
	generation: number;
	instanceId: string;
	profiles?: MitmProfileInputBundle;
}): MitmProfileBundle {
	return {
		schemaVersion: "clawdi.mitmProfiles.v1",
		generatedAt: input.generatedAt,
		generation: input.generation,
		instanceId: input.instanceId,
		profiles: input.profiles?.profiles ?? [],
	};
}

export function hasEnabledMitmProfiles(bundle: MitmProfileBundle): boolean {
	return bundle.profiles.some((profile) => profile.enabled);
}

export function writeMitmProfileBundle(bundle: MitmProfileBundle, paths: RuntimePaths): string {
	writePrivateFileAtomic(paths.mitmProfileBundle, `${JSON.stringify(bundle, null, 2)}\n`, {
		mode: 0o644,
		dirMode: 0o755,
	});
	return paths.mitmProfileBundle;
}
