import * as p from "@clack/prompts";
import type { components } from "@clawdi/shared/api";
import { ApiClient, ApiError, unwrap } from "../lib/api-client";
import { ClerkOAuthError } from "../lib/clerk-oauth";
import { requireUuid } from "../lib/cli-options";
import { emit } from "../lib/command-output";
import { confirmOrRequireYes } from "../lib/prompts";
import { requireAuth } from "../lib/require-auth";
import { sanitizeMetadata } from "../lib/sanitize";
import { isInteractive } from "../lib/tty";

function requireAgent(agentId: string): void {
	requireAuth();
	requireUuid(agentId, "Agent ID (from `clawdi agent list`)");
}

function requirePluginName(name: string): void {
	if (name.length > 64 || !/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(name))
		throw new Error(
			"Use an exact plugin name from the plugin catalog or `clawdi agent plugins list`.",
		);
}

function pluginError(error: unknown): never {
	if (error instanceof ClerkOAuthError) throw error;
	if (error instanceof ApiError) {
		if (error.status === 401 || error.isNetwork) throw error;
		if (error.status === 403)
			throw new Error(
				"You do not have permission to manage this agent's plugins. Sign in with `clawdi auth login`.",
			);
		if (error.status === 404)
			throw new Error(
				"Agent or plugin not found. Check `clawdi agent list` and the plugin catalog.",
			);
		if (error.status === 409)
			throw new Error(
				"This plugin cannot be installed on this agent. Use a supported Cloud Agent and an installable catalog plugin.",
			);
		throw new Error("Could not manage agent plugins. Please retry or run `clawdi doctor`.");
	}
	throw error;
}

export async function agentPluginsList(
	agentId: string,
	opts: { json?: boolean } = {},
): Promise<void> {
	requireAgent(agentId);
	try {
		const result = unwrap(
			await new ApiClient().GET("/v1/agents/{agent_id}/agent-plugins", {
				params: { path: { agent_id: agentId } },
			}),
		);
		if (result.plugins.some((plugin) => plugin.convergence === "failed")) process.exitCode = 1;
		if (opts.json) {
			emit({
				schemaVersion: "clawdi.agentPluginsList.v1",
				agent_id: agentId,
				...result,
			});
			return;
		}
		if (result.plugins.length === 0) console.log("No plugins requested for this agent.");
		for (const plugin of result.plugins) {
			console.log(
				`${sanitizeMetadata(plugin.plugin_name)}  ${sanitizeMetadata(plugin.version)}  ${plugin.convergence}`,
			);
			if (plugin.observation_error_code)
				console.error(`${sanitizeMetadata(plugin.plugin_name)}: ${plugin.observation_error_code}`);
		}
		console.log("Only installed convergence confirms runtime application.");
	} catch (error) {
		pluginError(error);
	}
}

export async function agentPluginsInstall(
	agentId: string,
	pluginName: string | undefined,
	opts: { json?: boolean; pluginVersion?: string } = {},
): Promise<void> {
	requireAgent(agentId);
	if (pluginName !== undefined) requirePluginName(pluginName);
	if (
		opts.pluginVersion !== undefined &&
		(!opts.pluginVersion.trim() ||
			opts.pluginVersion.length > 256 ||
			Array.from(opts.pluginVersion).some(
				(char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127,
			))
	)
		throw new Error("--plugin-version must be an exact version from the plugin catalog.");
	try {
		const api = new ApiClient();
		const catalog = unwrap(await api.GET("/v1/plugin-catalog"));
		let name = pluginName;
		if (name === undefined) {
			const choices = catalog.plugins.filter((plugin) => plugin.installable);
			if (!choices.length) throw new Error("No installable plugins are available in the catalog.");
			if (!isInteractive())
				throw new Error(
					`Choose a plugin name: ${choices.map((plugin) => sanitizeMetadata(plugin.name)).join(", ")}. Run \`clawdi agent plugins install ${agentId} <plugin-name>\`.`,
				);
			const selected = await p.select({
				output: process.stderr,
				message: "Choose a plugin to install",
				options: choices.map((plugin) => ({
					value: plugin.name,
					label: `${sanitizeMetadata(plugin.display_name)} (${sanitizeMetadata(plugin.name)} ${sanitizeMetadata(plugin.version)})`,
				})),
			});
			if (p.isCancel(selected)) {
				p.cancel("Cancelled.", { output: process.stderr });
				return;
			}
			name = selected;
		}
		requirePluginName(name);
		const entry = catalog.plugins.find((plugin) => plugin.name === name);
		if (!entry)
			throw new Error(
				"Plugin not found in the catalog. Run `clawdi agent plugins install <agent-id>` for choices.",
			);
		if (!entry.installable) throw new Error("This catalog plugin is not installable.");
		if (opts.pluginVersion !== undefined && opts.pluginVersion !== entry.version)
			throw new Error(
				`The catalog offers version ${sanitizeMetadata(entry.version)} for this plugin. Use that exact version or omit --plugin-version.`,
			);
		const body: components["schemas"]["AgentPluginInstallRequest"] = { version: entry.version };
		const result = unwrap(
			await api.PUT("/v1/agents/{agent_id}/agent-plugins/{plugin_name}", {
				params: { path: { agent_id: agentId, plugin_name: name } },
				body,
			}),
		);
		if (opts.json) {
			emit({
				schemaVersion: "clawdi.agentPluginsInstall.v1",
				status: "accepted",
				...result,
			});
		} else {
			console.log(
				`Plugin ${sanitizeMetadata(result.plugin_name)} installation request accepted. Run \`clawdi agent plugins list ${agentId}\` to check application.`,
			);
		}
		if (result.convergence === "failed") process.exitCode = 1;
	} catch (error) {
		pluginError(error);
	}
}

export async function agentPluginsRemove(
	agentId: string,
	pluginName: string,
	opts: { json?: boolean; yes?: boolean } = {},
): Promise<void> {
	requireAgent(agentId);
	requirePluginName(pluginName);
	if (
		!(await confirmOrRequireYes(`Remove plugin ${pluginName} from agent ${agentId}?`, {
			yes: opts.yes,
			action: "remove this agent plugin",
		}))
	)
		return;
	try {
		const result = unwrap(
			await new ApiClient().DELETE("/v1/agents/{agent_id}/agent-plugins/{plugin_name}", {
				params: { path: { agent_id: agentId, plugin_name: pluginName } },
			}),
		);
		if (opts.json) {
			emit({
				schemaVersion: "clawdi.agentPluginsRm.v1",
				status: "accepted",
				...result,
			});
		} else {
			console.log(
				`Plugin ${sanitizeMetadata(result.plugin_name)} removal request accepted. Run \`clawdi agent plugins list ${agentId}\` to check application.`,
			);
		}
	} catch (error) {
		pluginError(error);
	}
}
