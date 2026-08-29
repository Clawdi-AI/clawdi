import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	dialogExitRenderedValue,
	reduceDialogExitState,
} from "@/components/ui/use-dialog-exit-lifecycle";

const sourceRoot = resolve(import.meta.dir, "..");

function source(path: string) {
	return readFileSync(resolve(sourceRoot, path), "utf8");
}

describe("dialog exit lifecycle", () => {
	test("uses the repository Base UI completion and ending-state contract", () => {
		const helper = source("components/ui/use-dialog-exit-lifecycle.ts");
		const dialog = source("components/ui/dialog.tsx");
		const sheet = source("components/ui/sheet.tsx");
		expect(helper).toContain("Base UI's exit window");
		expect(helper).not.toContain("forceRender");
		expect(helper).not.toContain("keepMounted");
		expect(dialog).toContain("data-closed:animate-out");
		expect(sheet).toContain("data-ending-style:opacity-0");
	});

	test("clears caller form state after Base UI finishes closing", () => {
		for (const path of [
			"components/command-palette.tsx",
			"components/connectors/credentials-dialog.tsx",
			"components/settings/api-keys-panel.tsx",
			"components/projects/create-project-dialog.tsx",
			"components/projects/project-actions.tsx",
			"components/skills/create-skill-dialog.tsx",
			"components/vault/add-keys-dialog.tsx",
			"components/vault/vaults-surface.tsx",
			"components/memories/memories-surface.tsx",
			"hosted/v2/channels/channel-detail-page.tsx",
			"hosted/v2/channels/whatsapp-repair-dialog.tsx",
		]) {
			expect(source(path), path).toContain("onOpenChangeComplete");
		}
	});

	test("retains payment and credential payloads only for the existing exit window", () => {
		const checkout = source("hosted/billing/components/stripe-checkout-dialog.tsx");
		expect(checkout).toContain("useDialogExitLifecycle");
		expect(checkout).toContain("onOpenChangeComplete");
		expect(checkout).toContain("clientSecret: null");

		const runtime = source("hosted/agents/hosted-agent-detail.tsx");
		expect(runtime).toContain("renderedCredentials");
		expect(runtime).toContain("credentialExit.completeClose()");
	});

	test("retains runtime credentials when an identity refresh programmatically closes the dialog", () => {
		const credentials = { username: "runtime-user", password: "one-time-secret" };
		const closing = reduceDialogExitState(
			{ phase: "open" as const, snapshot: null as typeof credentials | null },
			{ type: "close", snapshot: credentials },
		);
		expect(dialogExitRenderedValue({ open: false, state: closing, value: null })).toEqual(
			credentials,
		);

		const runtime = source("hosted/agents/hosted-agent-detail.tsx");
		const identityClose = runtime.indexOf("if (open) credentialExit.beginClose()");
		expect(identityClose).toBeGreaterThan(-1);
		expect(runtime).toContain("clearCredentials();");
	});

	test("invalidates stale async writes independently from visual cleanup", () => {
		const credentials = source("components/connectors/credentials-dialog.tsx");
		expect(credentials).toContain("if (!nextOpen) openGenRef.current += 1");
		expect(credentials).toContain("onOpenChangeComplete");

		const provider = source("hosted/v2/ai-providers/add-provider-dialog.tsx");
		expect(provider).toContain("dialogSessionRef.current += 1");
		expect(provider).toContain("dialogSession !== dialogSessionRef.current");
		expect(provider).toContain("onOpenChangeComplete={completeOpenChange}");
		expect(provider).toContain("oauthExit.beginClose()");
		expect(provider).toContain("oauthExit.completeClose()");
	});

	test("keeps mutation dialogs under stable panel owners until Base UI completes exit", () => {
		const sharing = source("components/sharing/share-project-dialog.tsx");
		for (const target of ["renderedRevokeTarget", "renderedCancelTarget", "renderedRemoveTarget"]) {
			expect(sharing).toContain(target);
		}
		expect(sharing.match(/onOpenChangeComplete=/g)?.length).toBeGreaterThanOrEqual(3);
		expect(sharing).not.toContain(
			"<LinkRow\n\t\t\t\t\t\t\tkey={link.id}\n\t\t\t\t\t\t\tlink={link}\n\t\t\t\t\t\t\tonRevoke={() => revoke.mutate",
		);
	});
});
