/** Bundled with --target=node: process.execPath must be the Hosted system Node. */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { runOpenClawSdkCommand } from "../../../src/adapters/openclaw-command";
import {
	OPENCLAW_SDK_EXPORT_PATHS,
	resolveOpenClawSdkExport,
} from "../../../src/lib/codex-oauth-native-store";
import {
	createOpenClawHostedContextForHome,
	installedOpenClawCommandPath,
} from "../../../src/runtime/hosted-openclaw-context";
import type { RuntimeManifest } from "../../../src/runtime/manifest-contract";
import {
	discoverOpenClawManagedProviderAuthAgentDirs,
	ensureOpenClawProviderAuthCapability,
	openClawSupportsOwnerBrowserBootstrap,
	reconcileHostedRuntimeOAuthCredentials,
	removeOpenClawManagedProviderAuthProfiles,
} from "../../../src/runtime/manifest-oauth";
import {
	applyOpenClawConfigMergePatch,
	applyOpenClawContextMergePatch,
	applyOpenClawHostedChannelPatch,
	applyOpenClawHostedProviderPatch,
	beginOpenClawConfigTransaction,
	commitOpenClawConfigTransaction,
} from "../../../src/runtime/openclaw-provider-config";
import { getRuntimePaths } from "../../../src/runtime/paths";
import systemNode from "./system-node.json";

const home = process.env.HOME ?? "";
assert(home);
assert.equal(process.version, `v${systemNode.version}`);
process.env.CLAWDI_RUNTIME_MODE = "hosted";
process.env.CLAWDI_RUNTIME_USER = userInfo().username;
process.env.CLAWDI_RUNTIME_HOME = home;
process.env.CLAWDI_SERVICE_STATE_DIR = join(home, ".contract-node", "state");
process.env.CLAWDI_RUN_DIR = join(home, ".contract-node", "run");
mkdirSync(process.env.CLAWDI_RUN_DIR, { recursive: true });
const context = createOpenClawHostedContextForHome(home, true);
const command = installedOpenClawCommandPath(home);
assert(command);
const sdk = context.requireSdkExport("configMutation");
if (process.argv[2] === "transcript") {
	const sessionId = process.argv[3];
	const sessionKey = process.argv[4];
	assert(sessionId && sessionKey);
	const transcriptSdk = resolveOpenClawSdkExport(
		home,
		[command],
		OPENCLAW_SDK_EXPORT_PATHS.sessionTranscript,
	);
	assert(transcriptSdk);
	const output = await runOpenClawSdkCommand(
		transcriptSdk,
		{ agentId: "main", sessionId, sessionKey },
		{ timeout: 120_000, maxBuffer: 1024 * 1024 },
	);
	const entries: unknown = JSON.parse(output);
	assert(Array.isArray(entries) && entries.length >= 2);
	assert(output.includes("contract question") && output.includes("contract answer"));
	console.log("PASS native session transcript through system Node process.execPath");
	process.exit(0);
}
let failures = 0;
async function check(name: string, run: () => unknown | Promise<unknown>) {
	try {
		await run();
		console.log(`PASS ${name}`);
	} catch (error) {
		failures++;
		console.error(`FAIL ${name}: ${error instanceof Error ? error.stack : String(error)}`);
	}
}
console.log(`system Node: ${process.version}; executable: ${process.execPath}`);
await check("config merge SDK (openclaw-provider-config.ts:204)", () => {
	applyOpenClawConfigMergePatch(sdk, JSON.stringify({ gateway: { mode: "local" } }), home, home);
});
await check("provider SDK (openclaw-provider-config.ts:180)", () => {
	applyOpenClawHostedProviderPatch(
		{ apply: true, content: JSON.stringify({ gateway: { mode: "local" } }), providerIds: [] },
		command,
		context,
		home,
		"node-contract",
	);
});
await check("channel SDK (openclaw-provider-config.ts:265)", () => {
	applyOpenClawHostedChannelPatch({ channels: {} }, null, [], context, home);
});
await check("batch SDK (openclaw-provider-config.ts:73)", () => {
	beginOpenClawConfigTransaction(context, {});
	applyOpenClawContextMergePatch(context, { gateway: { mode: "local" } }, home);
	applyOpenClawHostedChannelPatch({ channels: {} }, null, [], context, home);
	commitOpenClawConfigTransaction(context, home);
});
await check("device bootstrap SDK (manifest-oauth.ts:243)", () => {
	assert.equal(typeof openClawSupportsOwnerBrowserBootstrap(context, "node-contract"), "boolean");
});
await check("provider-auth and cleanup capability SDKs (manifest-oauth.ts:290/310)", () => {
	ensureOpenClawProviderAuthCapability({
		context,
		revision: "node-contract",
		oauth: true,
		cleanupManagedProvider: true,
	});
});
await check("provider-auth discover/cleanup SDKs (manifest-oauth.ts:492/566)", () => {
	context.agentDirs.managed = discoverOpenClawManagedProviderAuthAgentDirs(
		context,
		"node-contract",
	);
	assert(context.agentDirs.managed.includes(context.agentDirs.main));
	removeOpenClawManagedProviderAuthProfiles(context, home, "node-contract");
});
await check("OAuth inspect/seed/remove SDK: exactly one JSON document on stdout", () => {
	const manifest: RuntimeManifest = {
		schemaVersion: "clawdi.runtimeDesiredState.v1",
		deploymentId: "hdep_contract",
		environmentId: "contract",
		instanceId: "contract",
		generation: 1,
		issuedAt: new Date().toISOString(),
		controlPlane: { apiUrl: "https://example.test" },
		recovery: {},
		runtimes: { openclaw: { enabled: true, services: {}, provider_ids: ["contract-oauth"] } },
		projection: {
			providers: {
				"contract-oauth": {
					auth: {
						type: "agent_profile",
						tool: "codex",
						profile: "contract",
						credentialSecretRef: "secret://contract/oauth",
						credentialRevision: "contract-1",
					},
				},
			},
		},
	};
	const secretValues = {
		"secret://contract/oauth": JSON.stringify({
			kind: "local_agent_profile",
			files: [
				{
					logicalName: "auth.json",
					content: JSON.stringify({
						tokens: {
							access_token: "contract-not-real-access",
							refresh_token: "contract-not-real-refresh",
						},
					}),
				},
			],
		}),
	};
	const input = {
		runtime: "openclaw" as const,
		manifest,
		secretValues,
		paths: getRuntimePaths({ mode: "hosted" }),
		home,
		openClawContext: context,
		workspaceRoot: home,
	};
	// The production helper in manifest-oauth.ts parses stdout with JSON.parse,
	// defaulting empty output to {}, and validates the native result. Prefix/suffix
	// logs or multiple JSON documents must fail; never extract a JSON substring.
	assert.doesNotThrow(
		() => reconcileHostedRuntimeOAuthCredentials(input),
		"OAuth inspect/seed stdout must be exactly one JSON document",
	);
	assert.doesNotThrow(
		() =>
			reconcileHostedRuntimeOAuthCredentials({
				...input,
				manifest: { ...manifest, projection: { providers: {} } },
			}),
		"OAuth inspect/remove stdout must be exactly one JSON document",
	);
});
await check("transcript SDK via process.execPath (openclaw-command.ts:64)", async () => {
	const transcriptSdk = resolveOpenClawSdkExport(
		home,
		[command],
		OPENCLAW_SDK_EXPORT_PATHS.sessionTranscript,
	);
	assert(transcriptSdk);
	const output = await runOpenClawSdkCommand(
		transcriptSdk,
		{
			agentId: "main",
			sessionId: "contract-missing-session",
			sessionKey: "agent:main:contract-missing-session",
		},
		{ timeout: 120_000, maxBuffer: 1024 * 1024 },
	);
	assert.deepEqual(JSON.parse(output), []);
});
process.exitCode = failures === 0 ? 0 : 1;
