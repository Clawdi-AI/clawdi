import { randomUUID } from "node:crypto";
import { ApiClient, ApiError, unwrap } from "../lib/api-client";
import { isLoggedIn } from "../lib/config";
import { HostedDeployClient } from "../lib/hosted-deploy-client";
import { sanitizeMetadata, stripTerminalEscapes } from "../lib/sanitize";

function requireAgentId(agentId: string): void {
	if (!isLoggedIn()) throw new Error("Not logged in. Run `clawdi auth login` first.");
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agentId)) {
		throw new Error("Use the full remote Cloud Agent UUID, not a local --agent type.");
	}
}

async function inventory(agentId: string) {
	requireAgentId(agentId);
	try {
		return unwrap(
			await new ApiClient().GET("/v1/agents/{agent_id}/skills", {
				params: { path: { agent_id: agentId } },
			}),
		);
	} catch (error) {
		if (error instanceof ApiError && error.body.includes("hosted_skill_runtime_required")) {
			throw new Error(
				"Remote Skills require a Hosted Hermes or OpenClaw Agent. Use `skill --agent <type>` for local Skills.",
			);
		}
		throw error;
	}
}

async function hostedWorkspace(agentId: string) {
	const client = new HostedDeployClient();
	const deployment = await client.getAgentDeployment(agentId);
	const deploymentId = deployment.resource.id;
	const workspace = await client.getWorkspaceSkills(deploymentId);
	return { client, deploymentId, workspace };
}

function print(value: unknown): void {
	console.log(JSON.stringify(value, null, 2));
}

export async function agentSkillsList(agentId: string, opts: { json?: boolean } = {}) {
	const desired = await inventory(agentId);
	const { workspace } = await hostedWorkspace(agentId);
	const failed =
		desired.skills.some((item) => item.convergence === "failed") ||
		Boolean(desired.removal_failures?.length) ||
		workspace.items?.some((item) => item.status === "failed");
	if (failed) process.exitCode = 1;
	if (opts.json || !process.stdout.isTTY) {
		print({ ...desired, workspace });
		return;
	}
	for (const skill of desired.skills) {
		console.log(
			`${sanitizeMetadata(skill.skill_key)}  ${skill.source}  ${skill.convergence}${skill.read_only ? "  read-only" : ""}`,
		);
		if (skill.observation_error_code)
			console.log(`  ${sanitizeMetadata(skill.observation_error_code)}`);
	}
	for (const item of workspace.items ?? []) {
		console.log(`${sanitizeMetadata(item.skill_key)}  GitHub request: ${item.status}`);
		if (item.failure_message) console.log(`  ${sanitizeMetadata(item.failure_message)}`);
	}
	for (const failure of desired.removal_failures ?? []) {
		console.log(
			`${sanitizeMetadata(failure.skill_key)}  removal failed: ${sanitizeMetadata(failure.observation_error_code)}`,
		);
	}
	if (!workspace.capability.available)
		console.log(`GitHub Skills unavailable: ${workspace.capability.reason}`);
	console.log(
		"Only installed convergence confirms runtime application; requested/managed state does not.",
	);
}

export async function agentSkillsRead(
	agentId: string,
	skillKey: string,
	opts: { json?: boolean } = {},
) {
	const desired = await inventory(agentId);
	const skill = desired.skills.find((item) => item.skill_key === skillKey);
	if (skill?.authority === "cloud" && skill.project_id && skill.source_skill_key) {
		const detail = unwrap(
			await new ApiClient().GET("/v1/projects/{project_id}/skills/{skill_key}", {
				params: { path: { project_id: skill.project_id, skill_key: skill.source_skill_key } },
			}),
		);
		if (opts.json || !process.stdout.isTTY) print({ ...skill, detail });
		else console.log(stripTerminalEscapes(detail.content ?? "Skill content is unavailable."));
		return;
	}
	if (skill?.source === "bundled") {
		throw new Error("Bundled Skill content is not exposed by the remote Skill API.");
	}
	const { client, deploymentId } = await hostedWorkspace(agentId);
	const detail = await client.getWorkspaceSkill(deploymentId, skillKey);
	if (opts.json || !process.stdout.isTTY) print({ ...skill, detail });
	else console.log(stripTerminalEscapes(detail.content));
}

interface InstallOptions {
	json?: boolean;
	github?: string;
	path?: string;
	library?: string;
	requestId?: string;
	resourceVersion?: string;
}

export async function agentSkillsInstall(agentId: string, opts: InstallOptions) {
	requireAgentId(agentId);
	if (Boolean(opts.github) === Boolean(opts.library)) {
		throw new Error(
			"Choose exactly one source: --github <public-repository> or --library <skill-id>.",
		);
	}
	if (opts.library) {
		if (opts.path || opts.requestId || opts.resourceVersion)
			throw new Error("--path, --request-id and --resource-version apply only to GitHub installs.");
		const result = unwrap(
			await new ApiClient().PUT("/v1/agents/{agent_id}/skill-references/{skill_id}", {
				params: { path: { agent_id: agentId, skill_id: opts.library } },
			}),
		);
		if (opts.json || !process.stdout.isTTY) print({ status: "accepted", ...result });
		else
			console.log(
				`Library Skill ${result.desired_state} request accepted. Run \`agent skills list ${agentId}\` to check application.`,
			);
		return;
	}
	await mutateGithubSkill(
		agentId,
		{ repo: opts.github ?? "", path: opts.path },
		undefined,
		opts.requestId,
		opts.resourceVersion,
		opts.json,
	);
}

export async function agentSkillsRemove(
	agentId: string,
	skillKey: string,
	opts: { requestId?: string; resourceVersion?: string; json?: boolean } = {},
) {
	const desired = await inventory(agentId);
	const skill = desired.skills.find((item) => item.skill_key === skillKey);
	if (skill?.read_only)
		throw new Error(
			"This Skill is managed by its linked Project or runtime and cannot be removed here.",
		);
	if (skill?.authority === "cloud" && skill.skill_id) {
		if (opts.requestId || opts.resourceVersion)
			throw new Error("--request-id and --resource-version apply only to GitHub removals.");
		const result = unwrap(
			await new ApiClient().DELETE("/v1/agents/{agent_id}/skill-references/{skill_id}", {
				params: { path: { agent_id: agentId, skill_id: skill.skill_id } },
			}),
		);
		if (opts.json || !process.stdout.isTTY) print({ status: "accepted", ...result });
		else
			console.log(
				`Library Skill ${result.desired_state} request accepted. Run \`agent skills list ${agentId}\` to check application.`,
			);
		return;
	}
	// Hosted may still have a requested GitHub entry before Cloud projects it.
	await mutateGithubSkill(
		agentId,
		undefined,
		skillKey,
		opts.requestId,
		opts.resourceVersion,
		opts.json,
	);
}

async function mutateGithubSkill(
	agentId: string,
	source: { repo: string; path?: string } | undefined,
	skillKey: string | undefined,
	requestedId?: string,
	requestedVersion?: string,
	json?: boolean,
) {
	const requestId = requestedId ?? randomUUID();
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
		throw new Error("--request-id must be a UUID; reuse it only for the same request.");
	}
	if (
		requestedVersion !== undefined &&
		(!requestedId ||
			!/^[\x21-\x7e]{1,128}$/.test(requestedVersion) ||
			/["\\]/.test(requestedVersion))
	) {
		throw new Error(
			"--resource-version must be an unquoted strong resource version accompanied by --request-id.",
		);
	}
	const { client, deploymentId, workspace } = await hostedWorkspace(agentId);
	const resourceVersion = requestedVersion ?? workspace.deployment_resource_version;
	if (!workspace.capability.available) {
		throw new Error(
			`Remote GitHub Skills are unavailable: ${workspace.capability.reason}. Upgrade the Agent and wait for capability observation.`,
		);
	}
	if (
		!source &&
		!requestedVersion &&
		!workspace.items?.some((item) => item.skill_key === skillKey)
	) {
		throw new Error(
			"GitHub Skill not found in the Hosted desired inventory; no change was requested.",
		);
	}
	try {
		const result = source
			? await client.installWorkspaceSkill(deploymentId, source, resourceVersion, requestId)
			: await client.removeWorkspaceSkill(deploymentId, skillKey ?? "", resourceVersion, requestId);
		if (json || !process.stdout.isTTY) {
			print({
				acceptance: "accepted",
				request_id: requestId,
				request_resource_version: resourceVersion,
				...result,
			});
		} else {
			console.log(
				`${sanitizeMetadata(result.skill_key)}: ${result.desired_state} request ${result.status}.`,
			);
			if (result.failure_message) console.log(sanitizeMetadata(result.failure_message));
			console.log(`Request ID: ${requestId}; resource version: ${resourceVersion}`);
			console.log(`Run \`agent skills list ${agentId}\` to check runtime application.`);
		}
		if (result.status === "failed") process.exitCode = 1;
	} catch (error) {
		const message = error instanceof Error ? error.message : "Remote Skill request failed.";
		throw new Error(
			`${message} Request ID: ${requestId}; resource version: ${resourceVersion}. Replay only with the same --request-id and --resource-version. Inspect \`agent skills list ${agentId}\` before retrying; acceptance does not prove application.`,
		);
	}
}
