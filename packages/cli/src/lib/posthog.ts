/** Optional CLI producer for the same PostHog project as Cloud and web. */
import { randomUUID } from "node:crypto";
import { ApiError } from "./api-client";
import { getAuth } from "./config";
import { AuthorizationRequiredError } from "./require-auth";

const COMMAND_GROUPS = [
	"auth",
	"setup",
	"status",
	"doctor",
	"push",
	"pull",
	"session",
	"daemon",
	"skill",
	"memory",
	"vault",
	"project",
	"inbox",
	"run",
	"read",
	"inject",
	"deploy",
	"agent",
	"ai-provider",
	"channel",
	"wallet",
	"config",
	"update",
	"teardown",
	"mcp",
	"runtime",
] as const;
type CommandGroup = (typeof COMMAND_GROUPS)[number] | "other";
export type FailureClass =
	| "auth"
	| "forbidden"
	| "validation"
	| "rate_limit"
	| "network"
	| "server"
	| "cancelled"
	| "unexpected";
export type CommandEvent = {
	name: "cli_command_completed" | "cli_command_failed";
	properties: {
		command_group: CommandGroup;
		duration_ms: number;
		failure_class: FailureClass | null;
	};
};

export function cliFailureClass(error: unknown): FailureClass {
	if (error instanceof AuthorizationRequiredError) return "auth";
	if (error instanceof ApiError) {
		if (error.status === 401) return "auth";
		if (error.status === 403) return "forbidden";
		if (error.status === 429) return "rate_limit";
		if (error.status === 0) return "network";
		if (error.status >= 500) return "server";
		return "validation";
	}
	if (error instanceof Error && error.name === "AbortError") return "cancelled";
	return "unexpected";
}

export function commandEvent(command: string, durationMs: number, error?: unknown): CommandEvent {
	const root = command.split(" ")[0];
	const commandGroup = COMMAND_GROUPS.find((group) => group === root) ?? "other";
	return {
		name: error === undefined ? "cli_command_completed" : "cli_command_failed",
		properties: {
			command_group: commandGroup,
			duration_ms: Math.min(
				86_400_000,
				Math.max(0, Math.round(Number.isFinite(durationMs) ? durationMs : 0)),
			),
			failure_class: error === undefined ? null : cliFailureClass(error),
		},
	};
}

export async function reportCommandEvent(event: CommandEvent): Promise<boolean> {
	if (process.env.CLAWDI_ANALYTICS !== "true" || process.env.DO_NOT_TRACK === "1") return false;
	const key = process.env.POSTHOG_API_KEY?.trim();
	if (!key) return false;
	try {
		const auth = getAuth();
		// Legacy API keys and runtime env tokens do not carry a trustworthy Clerk
		// subject. Never invent another distinct_id or decode an unverified token.
		if (auth?.authType !== "clerk_oauth" || !auth.subject?.trim()) return false;
		const { PostHog } = await import("posthog-node");
		const client = new PostHog(key, {
			host: process.env.POSTHOG_HOST || "https://us.i.posthog.com",
			requestTimeout: 750,
			fetchRetryCount: 0,
		});
		client.on("error", () => {
			/* Telemetry must not print internal errors. */
		});
		try {
			await client.captureImmediate({
				distinctId: auth.subject,
				event: event.name,
				disableGeoip: true,
				properties: {
					...event.properties,
					source: "cli",
					schema_version: 1,
					$insert_id: randomUUID(),
				},
			});
			return true;
		} finally {
			await client.shutdown(750);
		}
	} catch {
		return false;
	}
}
