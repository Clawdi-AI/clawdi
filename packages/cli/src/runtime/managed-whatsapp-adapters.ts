import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveCurrentCliResourceRoot } from "../lib/current-cli-invocation";
import { writePrivateFileAtomic } from "../lib/private-file";
import { WHATSAPP_UPSTREAM_READY } from "./whatsapp-gate";

export const MANAGED_WHATSAPP_OPENCLAW_PLUGIN_ID = "clawdi-whatsapp";
export const MANAGED_WHATSAPP_CHANNEL_ID = "whatsapp";
export const MANAGED_WHATSAPP_HERMES_PLUGIN_ID = "clawdi-whatsapp";

export const MANAGED_WHATSAPP_OPENCLAW_UPSTREAM = {
	version: "2026.7.1",
	commit: "0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c",
} as const;

export const MANAGED_WHATSAPP_HERMES_UPSTREAM = {
	version: "0.19.1",
	commit: "f3cda0ceb18d8ba7465a6d223098ef0e56c8fee1",
} as const;

const MANAGED_ADAPTER_MARKER = ".clawdi-managed-adapter.json";
const ADAPTER_RESOURCE_ROOT = ["runtime-adapters", "whatsapp"] as const;
const OPENCLAW_ASSET_FILES = [
	"api.js",
	"channel-plugin-api.js",
	"index.js",
	"openclaw.plugin.json",
	"package.json",
	"plugin.js",
	"relay-client.js",
] as const;
const HERMES_ASSET_FILES = ["__init__.py", "adapter.py", "plugin.yaml"] as const;

export type ManagedWhatsAppAdapterRuntime = "openclaw" | "hermes";

export interface ManagedWhatsAppAdapterReadiness {
	runtime: ManagedWhatsAppAdapterRuntime;
	ready: boolean;
	installerArtifactsPinned: false;
	deploymentReproducible: false;
	blockers: string[];
	auditedUpstream: { version: string; commit: string };
}

export interface ManagedWhatsAppAdapterAsset {
	path: string;
	content: string;
}

export interface ManagedWhatsAppAdapterBundle {
	schemaVersion: "clawdi.managedWhatsAppAdapterBundle.v1";
	runtime: ManagedWhatsAppAdapterRuntime;
	pluginId: "clawdi-whatsapp";
	channelId: "whatsapp";
	revision: string;
	assets: ManagedWhatsAppAdapterAsset[];
	readiness: ManagedWhatsAppAdapterReadiness;
}

export interface ManagedWhatsAppAdapterDesiredAccount {
	accountId: string;
	accountKey: string;
	relayUrl: string;
	linkTokenSecretRef: string;
}

export interface ManagedWhatsAppAdapterProjection {
	openclaw: {
		channel: Record<string, unknown>;
		env: Record<string, string>;
		secretEnv: Record<string, string>;
		plugins: { entries: Record<string, { enabled: boolean }> };
	};
	hermes: {
		plugins: { enabled: string[] };
		platforms: Record<string, unknown>;
		env: Record<string, string>;
		secretEnv: Record<string, string>;
	};
}

export function managedWhatsAppAdapterReadiness(
	runtime: ManagedWhatsAppAdapterRuntime,
): ManagedWhatsAppAdapterReadiness {
	const blockers = [
		"WHATSAPP_UPSTREAM_READY is false",
		"official runtime installer URLs are mutable and do not prove the audited runtime commit",
	];
	if (runtime === "openclaw") {
		blockers.push(
			"OpenClaw 2026.7.1 0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c src/channels/plugins/outbound.types.ts:21-49 and src/channels/message/types.ts:168-187 mark deliveryQueueId @internal; src/channels/message/types.ts:274-292 exposes public queueId only after an unknown outcome, so arbitrary initial outbound lacks a public stable idempotency identity",
		);
	}
	if (runtime === "hermes") {
		blockers.push(
			"Hermes 0.19.1 f3cda0ceb18d8ba7465a6d223098ef0e56c8fee1 gateway/platforms/base.py:3476-3495 and 5023-5080 expose no public stable obligation identity for retry-safe arbitrary relay outbound",
		);
	}
	return {
		runtime,
		ready: false,
		installerArtifactsPinned: false,
		deploymentReproducible: false,
		blockers,
		auditedUpstream:
			runtime === "openclaw"
				? MANAGED_WHATSAPP_OPENCLAW_UPSTREAM
				: MANAGED_WHATSAPP_HERMES_UPSTREAM,
	};
}

export function managedWhatsAppAdapterCanActivate(runtime: ManagedWhatsAppAdapterRuntime): boolean {
	return WHATSAPP_UPSTREAM_READY && managedWhatsAppAdapterReadiness(runtime).ready;
}

export function buildManagedWhatsAppAdapterBundle(
	runtime: ManagedWhatsAppAdapterRuntime,
	resourceRoot = resolveCurrentCliResourceRoot(),
): ManagedWhatsAppAdapterBundle {
	const files = runtime === "openclaw" ? OPENCLAW_ASSET_FILES : HERMES_ASSET_FILES;
	const sourceRoot = resolve(resourceRoot, ...ADAPTER_RESOURCE_ROOT, runtime);
	const assets = files.map((path) => ({
		path,
		content: readRequiredAsset(sourceRoot, path),
	}));
	validateManagedWhatsAppAdapterAssets(runtime, assets);
	const revision = createHash("sha256")
		.update(
			JSON.stringify({
				runtime,
				pluginId: MANAGED_WHATSAPP_OPENCLAW_PLUGIN_ID,
				channelId: MANAGED_WHATSAPP_CHANNEL_ID,
				assets,
			}),
		)
		.digest("hex");
	return {
		schemaVersion: "clawdi.managedWhatsAppAdapterBundle.v1",
		runtime,
		pluginId: MANAGED_WHATSAPP_OPENCLAW_PLUGIN_ID,
		channelId: MANAGED_WHATSAPP_CHANNEL_ID,
		revision,
		assets,
		readiness: managedWhatsAppAdapterReadiness(runtime),
	};
}

export function buildManagedWhatsAppAdapterProjection(
	account: ManagedWhatsAppAdapterDesiredAccount,
): ManagedWhatsAppAdapterProjection {
	const accountId = requiredValue(account.accountId, "WhatsApp account ID");
	const accountKey = requiredValue(account.accountKey, "WhatsApp account key");
	const relayUrl = normalizedRelayUrl(account.relayUrl);
	const secretRef = requiredValue(account.linkTokenSecretRef, "WhatsApp link token secret ref");
	return {
		openclaw: {
			channel: {
				enabled: true,
				defaultAccount: accountKey,
				accounts: { [accountKey]: { enabled: true } },
			},
			env: {
				CLAWDI_WHATSAPP_RELAY_URL: relayUrl,
				CLAWDI_WHATSAPP_ACCOUNT_ID: accountId,
			},
			secretEnv: { CLAWDI_WHATSAPP_LINK_TOKEN: secretRef },
			plugins: {
				entries: {
					whatsapp: { enabled: false },
					[MANAGED_WHATSAPP_OPENCLAW_PLUGIN_ID]: { enabled: true },
				},
			},
		},
		hermes: {
			plugins: { enabled: [MANAGED_WHATSAPP_HERMES_PLUGIN_ID] },
			platforms: {
				whatsapp: { enabled: true, extra: { managed_by: "clawdi" } },
			},
			env: {
				CLAWDI_WHATSAPP_RELAY_URL: relayUrl,
				CLAWDI_WHATSAPP_ACCOUNT_ID: accountId,
			},
			secretEnv: { CLAWDI_WHATSAPP_LINK_TOKEN: secretRef },
		},
	};
}

export function managedWhatsAppAdapterTargetDir(
	home: string,
	runtime: ManagedWhatsAppAdapterRuntime,
): string {
	const normalizedHome = resolve(requiredValue(home, "runtime home"));
	return runtime === "openclaw"
		? join(normalizedHome, ".openclaw", "extensions", MANAGED_WHATSAPP_OPENCLAW_PLUGIN_ID)
		: join(normalizedHome, ".hermes", "plugins", MANAGED_WHATSAPP_HERMES_PLUGIN_ID);
}

export function reconcileManagedWhatsAppAdapterBundle(input: {
	home: string;
	runtime: ManagedWhatsAppAdapterRuntime;
	desired: ManagedWhatsAppAdapterBundle | null;
}): string | null {
	const target = managedWhatsAppAdapterTargetDir(input.home, input.runtime);
	assertManagedAdapterTarget(target, input.runtime);
	if (!input.desired) {
		removeManagedAdapterDirectory(target, input.runtime);
		return null;
	}
	if (input.desired.runtime !== input.runtime) {
		throw new Error("managed WhatsApp adapter runtime does not match its target");
	}
	const current = readManagedAdapterMarker(target, input.runtime);
	if (current?.revision === input.desired.revision && bundleFilesMatch(target, input.desired)) {
		return target;
	}
	if (existsSync(target) && !current && readdirSync(target).length > 0) {
		throw new Error(`refusing to overwrite unmanaged WhatsApp adapter directory ${target}`);
	}
	mkdirSync(target, { recursive: true, mode: 0o700 });
	const expected = new Set(input.desired.assets.map((asset) => asset.path));
	for (const entry of readdirSync(target)) {
		if (entry === MANAGED_ADAPTER_MARKER || expected.has(entry)) continue;
		if (current) rmSync(join(target, entry), { recursive: true, force: true });
	}
	for (const asset of input.desired.assets) {
		const path = managedAssetPath(target, asset.path);
		writePrivateFileAtomic(path, asset.content, { mode: 0o600, dirMode: 0o700 });
	}
	writePrivateFileAtomic(
		join(target, MANAGED_ADAPTER_MARKER),
		`${JSON.stringify(
			{
				schemaVersion: "clawdi.managedWhatsAppAdapterReceipt.v1",
				runtime: input.runtime,
				pluginId: input.desired.pluginId,
				channelId: input.desired.channelId,
				desiredRevision: input.desired.revision,
				currentRevision: input.desired.revision,
			},
			null,
			2,
		)}\n`,
		{ mode: 0o600, dirMode: 0o700 },
	);
	return target;
}

export function managedWhatsAppAdapterMutationTargets(home: string): string[] {
	return (["openclaw", "hermes"] as const).map((runtime) =>
		managedWhatsAppAdapterTargetDir(home, runtime),
	);
}

function readRequiredAsset(root: string, path: string): string {
	const resolved = managedAssetPath(root, path);
	try {
		const content = readFileSync(resolved, "utf8");
		if (!content.trim()) throw new Error("asset is empty");
		return content;
	} catch (error) {
		throw new Error(
			`managed WhatsApp adapter asset ${path} is unavailable: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

function validateManagedWhatsAppAdapterAssets(
	runtime: ManagedWhatsAppAdapterRuntime,
	assets: ManagedWhatsAppAdapterAsset[],
): void {
	const joined = assets.map((asset) => asset.content).join("\n");
	const normalized = joined.toLowerCase();
	for (const forbidden of [
		["graph", "facebook"].join("."),
		"baileys",
		"provider credential",
		"signal credential",
		"websocket bridge",
	]) {
		if (normalized.includes(forbidden)) {
			throw new Error(`managed WhatsApp ${runtime} adapter contains forbidden ${forbidden}`);
		}
	}
	if (runtime === "openclaw") {
		const manifest = JSON.parse(requiredAsset(assets, "openclaw.plugin.json")) as {
			id?: unknown;
			channels?: unknown;
		};
		if (
			manifest.id !== MANAGED_WHATSAPP_OPENCLAW_PLUGIN_ID ||
			JSON.stringify(manifest.channels) !== JSON.stringify([MANAGED_WHATSAPP_CHANNEL_ID])
		) {
			throw new Error("managed WhatsApp OpenClaw manifest identity is invalid");
		}
		const plugin = requiredAsset(assets, "plugin.js");
		const relayClient = requiredAsset(assets, "relay-client.js");
		for (const required of [
			"createDurableInboundReceiveJournalFromQueue",
			"after_agent_dispatch",
			"processDurableInboxEvent",
			"saveMediaBuffer",
			"actions: messageActions",
			"sendTyping",
			"clearTyping",
			"arbitraryOutboundBlocker",
			"buildMarkReadOperation",
		]) {
			if (!plugin.includes(required)) {
				throw new Error(`managed WhatsApp OpenClaw adapter is missing ${required}`);
			}
		}
		for (const required of [
			"journal.complete",
			"client.acknowledge",
			"journal.release",
			"replayDurableInboxEvent",
		]) {
			if (!relayClient.includes(required)) {
				throw new Error(`managed WhatsApp OpenClaw relay client is missing ${required}`);
			}
		}
		if (
			!/await journal\.complete\([\s\S]*?await client\.acknowledge\(/u.test(relayClient) ||
			/await journal\.complete\([\s\S]*?journal\.release\(/u.test(
				relayClient.slice(relayClient.indexOf("export async function replayDurableInboxEvent")),
			)
		) {
			throw new Error("managed WhatsApp OpenClaw adapter ACK ordering is invalid");
		}
		for (const required of ["reply", "react", "edit", "delete", "unsend"]) {
			if (!relayClient.includes(`action === "${required}"`)) {
				throw new Error(`managed WhatsApp OpenClaw adapter is missing ${required} action mapping`);
			}
		}
		for (const unsupported of ["read", "set-presence"]) {
			if (!plugin.includes(unsupported)) {
				throw new Error(
					`managed WhatsApp OpenClaw adapter must explain why ${unsupported} is unavailable`,
				);
			}
		}
		if (plugin.includes("deliveryQueueId") || plugin.includes("durableFinal")) {
			throw new Error("managed WhatsApp OpenClaw adapter claims a private durable outbound seam");
		}
		return;
	}
	const manifest = parseYaml(requiredAsset(assets, "plugin.yaml")) as Record<string, unknown>;
	if (manifest.name !== MANAGED_WHATSAPP_HERMES_PLUGIN_ID || manifest.kind !== "platform") {
		throw new Error("managed WhatsApp Hermes manifest identity is invalid");
	}
	for (const required of [
		"BasePlatformAdapter",
		"MessageEvent",
		"ProcessingOutcome",
		"cache_media_bytes",
		'name="whatsapp"',
		"ctx.register_platform",
		"async def connect(self, *, is_reconnect=False)",
		"async def on_processing_complete(self, event, outcome)",
		"self.journal.complete(event_id)",
		"await self._finalize_completed(event_id, raw_event)",
		"self.journal.release(event_id",
		"await self.handle_message(event)",
		"WhatsApp media payload exceeds 8 MiB",
		'"type": "mark_read"',
		"durable_outbound_unavailable",
	]) {
		if (!joined.includes(required)) {
			throw new Error(`managed WhatsApp Hermes adapter is missing ${required}`);
		}
	}
	if (joined.includes("uuid") || joined.includes("uuid4") || joined.includes("randomUUID")) {
		throw new Error("managed WhatsApp Hermes adapter must not generate retry operation IDs");
	}
	const dispatch = joined.slice(
		joined.indexOf("async def _dispatch_pending"),
		joined.indexOf("async def _finalize_completed"),
	);
	if (
		!dispatch.includes("await self.handle_message(event)") ||
		dispatch.includes("_acknowledge(")
	) {
		throw new Error("managed WhatsApp Hermes adapter ACKs before processing completion");
	}
	const completion = joined.slice(
		joined.indexOf("async def on_processing_complete"),
		joined.indexOf("def _target"),
	);
	if (
		!completion.includes("outcome == ProcessingOutcome.SUCCESS") ||
		!completion.includes("self.journal.complete(event_id)") ||
		!completion.includes("await self._finalize_completed(event_id, raw_event)") ||
		!completion.includes("self.journal.release(event_id")
	) {
		throw new Error("managed WhatsApp Hermes completion-hook ACK contract is invalid");
	}
}

function requiredAsset(assets: ManagedWhatsAppAdapterAsset[], path: string): string {
	const asset = assets.find((candidate) => candidate.path === path);
	if (!asset) throw new Error(`managed WhatsApp adapter is missing ${path}`);
	return asset.content;
}

function normalizedRelayUrl(value: string): string {
	const url = new URL(requiredValue(value, "WhatsApp relay URL"));
	if (
		(url.protocol !== "https:" && url.protocol !== "http:") ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new Error(
			"WhatsApp relay URL must use HTTP or HTTPS without URL credentials, query, or fragment",
		);
	}
	return url.toString().replace(/\/+$/, "");
}

function requiredValue(value: string, label: string): string {
	const normalized = value.trim();
	if (!normalized) throw new Error(`${label} is required`);
	return normalized;
}

function managedAssetPath(root: string, assetPath: string): string {
	if (!assetPath || assetPath.includes("/") || assetPath.includes("\\")) {
		throw new Error(`managed WhatsApp adapter asset path is invalid: ${assetPath}`);
	}
	const resolvedRoot = resolve(root);
	const resolvedPath = resolve(resolvedRoot, assetPath);
	const candidate = relative(resolvedRoot, resolvedPath);
	if (!candidate || candidate.startsWith("..")) {
		throw new Error(`managed WhatsApp adapter asset escapes its root: ${assetPath}`);
	}
	return resolvedPath;
}

function assertManagedAdapterTarget(target: string, runtime: ManagedWhatsAppAdapterRuntime): void {
	let candidate = target;
	while (dirname(candidate) !== candidate) {
		if (existsSync(candidate) && lstatSync(candidate).isSymbolicLink()) {
			throw new Error(`refusing to write WhatsApp adapter through symlinked path ${candidate}`);
		}
		candidate = dirname(candidate);
	}
	const expected = runtime === "openclaw" ? ".openclaw/extensions" : ".hermes/plugins";
	if (!target.replaceAll("\\", "/").includes(`/${expected}/`)) {
		throw new Error(`managed WhatsApp adapter target is outside the default ${runtime} profile`);
	}
}

function readManagedAdapterMarker(
	target: string,
	runtime: ManagedWhatsAppAdapterRuntime,
): { revision: string } | null {
	try {
		const value = JSON.parse(readFileSync(join(target, MANAGED_ADAPTER_MARKER), "utf8")) as {
			schemaVersion?: unknown;
			runtime?: unknown;
			currentRevision?: unknown;
		};
		return value.schemaVersion === "clawdi.managedWhatsAppAdapterReceipt.v1" &&
			value.runtime === runtime &&
			typeof value.currentRevision === "string" &&
			/^[a-f0-9]{64}$/.test(value.currentRevision)
			? { revision: value.currentRevision }
			: null;
	} catch {
		return null;
	}
}

function bundleFilesMatch(target: string, bundle: ManagedWhatsAppAdapterBundle): boolean {
	return bundle.assets.every((asset) => {
		try {
			return readFileSync(managedAssetPath(target, asset.path), "utf8") === asset.content;
		} catch {
			return false;
		}
	});
}

function removeManagedAdapterDirectory(
	target: string,
	runtime: ManagedWhatsAppAdapterRuntime,
): void {
	if (!readManagedAdapterMarker(target, runtime)) return;
	rmSync(target, { recursive: true, force: true });
}
