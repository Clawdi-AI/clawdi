import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { parse as parseYaml } from "yaml";
import { type PrivateFileEvidence, readPrivateFileEvidence } from "../lib/private-file";
import { withRuntimeConvergeLockAsync } from "./converge-lock";
import { withEffectiveFilesystemIdentity } from "./effective-identity";
import { assertHostedRuntimeContract } from "./hosted-runtime-contract";
import type { RuntimeManifest } from "./manifest-contract";
import { canonicalJsonEqual, recordValue } from "./manifest-shared";
import { loadRemoteRuntimeManifest } from "./manifest-source";
import { getRuntimePaths, type RuntimePaths } from "./paths";
import { providerOwnershipJournalSchema, writeProviderOwnership } from "./provider-ownership";
import { type RuntimeUserIdentity, runningAsRoot } from "./runtime-user-command";

const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");

/** Caller holds the converge lock. Writes only the protected ownership journal. */
export function applyProviderIdentityHandoff(
	paths: RuntimePaths,
	manifest: RuntimeManifest,
	handoffId: string,
	nativeIdentity: RuntimeUserIdentity,
): string {
	const handoff = manifest.providerHandoffs?.find((item) => item.handoffId === handoffId);
	if (!handoff?.owned)
		throw new Error("No current Cloud-authorized native handoff for this runtime");
	const journalPath = join(paths.serviceStateRoot, "provider-ownership.json");
	const configPath = join(
		paths.userHome,
		`.${handoff.runtime}`,
		handoff.runtime === "hermes" ? "config.yaml" : "openclaw.json",
	);
	const envPath = join(paths.userHome, `.${handoff.runtime}`, ".env");
	if (paths.mode === "hosted" && (nativeIdentity.uid === 0 || nativeIdentity.gid === 0))
		throw new Error("Native provider files require a non-root runtime identity");
	const opened: PrivateFileEvidence[] = [];
	const capture = (path: string, identity: RuntimeUserIdentity, modes: readonly number[]) => {
		const evidence = readPrivateFileEvidence(path, { ...identity, modes, maxBytes: 1024 * 1024 });
		opened.push(evidence);
		return evidence;
	};
	const asNative = <T>(read: () => T & (T extends PromiseLike<unknown> ? never : unknown)) =>
		withEffectiveFilesystemIdentity(nativeIdentity, read);
	try {
		const rootIdentity = paths.mode === "hosted" ? { uid: 0, gid: 0 } : nativeIdentity;
		const journalEvidence = capture(journalPath, rootIdentity, [0o600]);
		const configEvidence = asNative(() => capture(configPath, nativeIdentity, [0o600, 0o644]));
		const envEvidence = asNative(() => capture(envPath, nativeIdentity, [0o600]));
		const journalBytes = journalEvidence.content;
		const config = configEvidence.content;
		const env = envEvidence.content;
		const assertCurrent = () => {
			journalEvidence.assertCurrent();
			asNative(() => {
				configEvidence.assertCurrent();
				envEvidence.assertCurrent();
			});
		};
		if (
			digest(config) !== handoff.expectedConfigSha256 ||
			digest(env) !== handoff.expectedEnvSha256
		)
			throw new Error("Native configuration changed since operator authorization");
		const journal = providerOwnershipJournalSchema.parse(JSON.parse(journalBytes.toString("utf8")));
		if (journal.instanceId !== manifest.instanceId || journal.home !== paths.userHome)
			throw new Error("Provider handoff belongs to another runtime incarnation");
		const entry = journal.transfers[handoff.runtime][handoff.providerId];
		if (entry?.pendingCreation) throw new Error("No completed native ownership to hand off");
		if (
			entry?.handoffId === handoffId &&
			entry.envName === handoff.envName &&
			canonicalJsonEqual(entry.cloudIdentity, handoff.cloudIdentity)
		) {
			assertCurrent();
			return "already_applied";
		}
		if (
			digest(journalBytes) !== handoff.expectedJournalSha256 ||
			(entry?.envName ?? null) !== handoff.journalEnvName ||
			(entry?.cloudIdentity && !canonicalJsonEqual(entry.cloudIdentity, handoff.cloudIdentity))
		)
			throw new Error("Native journal or provider incarnation changed since authorization");
		const native = recordValue(
			handoff.runtime === "hermes"
				? parseYaml(config.toString("utf8"))
				: JSON.parse(config.toString("utf8")),
		);
		const providers = recordValue(
			handoff.runtime === "hermes" ? native?.providers : recordValue(native?.models)?.providers,
		);
		const provider = recordValue(providers?.[handoff.providerId]);
		const ref = recordValue(provider?.apiKey);
		if (
			!provider ||
			!parseEnv(env.toString("utf8"))[handoff.envName] ||
			(handoff.runtime === "hermes"
				? (provider.key_env ?? provider.api_key_env) !== handoff.envName ||
					!!provider.api_key ||
					!!provider.key_cmd ||
					(!!provider.api_key_env && provider.api_key_env !== handoff.envName)
				: ref?.source !== "env" ||
					ref.id !== handoff.envName ||
					!["default", "clawdi-connection"].includes(String(ref.provider)))
		)
			throw new Error("Native credential reference does not match the authorized handoff");
		assertCurrent();
		journal.transfers[handoff.runtime][handoff.providerId] = {
			...entry,
			baseUrl: handoff.baseUrl,
			apiMode: handoff.apiMode,
			cloudIdentity: handoff.cloudIdentity,
			envName: handoff.envName,
			handoffId,
		};
		writeProviderOwnership(paths, manifest.instanceId, paths.userHome, journal, {
			directoryFd: journalEvidence.directoryFd,
			beforeRename: assertCurrent,
		});
		return "applied";
	} finally {
		for (const evidence of opened.reverse()) evidence.close();
	}
}

export async function providerIdentityHandoff(handoffId: string): Promise<void> {
	if (!runningAsRoot())
		throw new Error("Provider identity handoff requires the runtime root operator");
	const paths = getRuntimePaths({ mode: "hosted" });
	await withRuntimeConvergeLockAsync(paths, async () => {
		const load = await loadRemoteRuntimeManifest(paths);
		if (!("manifest" in load))
			throw new Error("Current Cloud handoff authorization is unavailable");
		try {
			if (!load.applyContext) throw new Error("Runtime apply context is missing");
			const { identity } = assertHostedRuntimeContract(paths, load.applyContext);
			const state = applyProviderIdentityHandoff(paths, load.manifest, handoffId, identity);
			console.log(JSON.stringify({ handoffId, state }));
		} catch {
			throw new Error(
				"Provider handoff rejected: native identity, evidence, or journal CAS changed",
			);
		}
	});
}
