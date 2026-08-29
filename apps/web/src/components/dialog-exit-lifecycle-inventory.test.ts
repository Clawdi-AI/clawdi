import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const sourceRoot = resolve(import.meta.dir, "..");

// Stateful callers whose retained payload or target is owned by the shared contract.
const SHARED_LIFECYCLE = [
	"components/sharing/share-project-dialog.tsx",
	"components/settings/api-keys-panel.tsx",
	"components/vault/split-vault-dialog.tsx",
	"hosted/agents/hosted-agent-detail.tsx",
	"hosted/billing/components/stripe-checkout-dialog.tsx",
	"hosted/billing/subscription/plan-change-dialog.tsx",
	"hosted/v2/ai-providers/add-provider-dialog.tsx",
] as const;

// Local form state already remains mounted for Base UI's exit window; these callers only
// need to reset in onOpenChangeComplete and do not benefit from duplicating a snapshot.
const COMPLETION_ONLY = [
	"components/command-palette.tsx",
	"components/connectors/credentials-dialog.tsx",
	"components/dashboard/agent-projects-tab.tsx",
	"components/dashboard/workspace-skills-panel.tsx",
	"components/memories/memories-surface.tsx",
	"components/projects/create-project-dialog.tsx",
	"components/projects/project-actions.tsx",
	"components/skills/create-skill-dialog.tsx",
	"components/skills/send-skill-dialog.tsx",
	"components/ui/confirm-action.tsx",
	"components/vault/add-keys-dialog.tsx",
	"components/vault/vaults-surface.tsx",
	"hosted/agents/hosted-workspace-skills-panel.tsx",
	"hosted/billing/wallet/auto-reload-setup-dialog.tsx",
	"hosted/billing/wallet/top-up-dialog.tsx",
	"hosted/billing/wallet/x402-card.tsx",
	"hosted/v2/ai-providers/ai-providers-page.tsx",
	"hosted/v2/ai-providers/provider-connection-test.tsx",
	"hosted/v2/channels/channel-detail-page.tsx",
	"hosted/v2/channels/connect-bot-dialog.tsx",
	"hosted/v2/channels/whatsapp-repair-dialog.tsx",
	"pages/dashboard/skills/page.tsx",
	"pages/dashboard/vault/[slug]/page.tsx",
] as const;

// Intentional exceptions: stateless wrappers/simple confirmations, navigation-owned shells,
// or responsive presentation switches with no close-time payload reset. Pairing callers are
// canonical #725 code and deliberately outside this follow-up.
const STATELESS_OR_CANONICAL = [
	"components/dashboard/add-agent-dialog.tsx",
	"components/dashboard/daemon-status.tsx",
	"components/dashboard/new-agent-button.tsx",
	"components/settings-dialog.tsx",
	"components/unsaved-navigation-guard.tsx",
	"components/ui/command.tsx",
	"components/ui/sidebar.tsx",
	"components/vault/copy-keys-dialog.tsx",
	"hosted/agents/deployment-delete-action.tsx",
	"hosted/billing/subscription/subscription-create-dialog.tsx",
	"hosted/v2/channels/discord-pair-dialog.tsx",
	"hosted/v2/channels/paired-chats-dialog.tsx",
	"hosted/v2/channels/pairing-dialog-ui.tsx",
	"hosted/v2/channels/telegram-pair-dialog.tsx",
	"hosted/v2/channels/whatsapp-pair-dialog.tsx",
	"pages/dashboard/projects/[id]/page.tsx",
] as const;

describe("stateful popup lifecycle inventory", () => {
	test("classifies every Dialog, AlertDialog, or Sheet caller", async () => {
		const discovered: string[] = [];
		for await (const file of new Bun.Glob("**/*.tsx").scan(sourceRoot)) {
			const contents = readFileSync(resolve(sourceRoot, file), "utf8");
			if (
				/from "@\/components\/ui\/(dialog|alert-dialog|sheet)"/.test(contents) ||
				(contents.includes("<CommandDialog") && contents.includes('from "@/components/ui/command"'))
			) {
				discovered.push(relative(sourceRoot, resolve(sourceRoot, file)));
			}
		}
		const classified = [...SHARED_LIFECYCLE, ...COMPLETION_ONLY, ...STATELESS_OR_CANONICAL];
		expect(discovered.sort()).toEqual([...classified].sort());
	});

	test("uses the shared snapshot owner only where payload retention is required", () => {
		for (const path of SHARED_LIFECYCLE) {
			expect(readFileSync(resolve(sourceRoot, path), "utf8"), path).toContain(
				"useDialogExitLifecycle",
			);
		}
		for (const path of COMPLETION_ONLY) {
			expect(readFileSync(resolve(sourceRoot, path), "utf8"), path).toContain(
				"onOpenChangeComplete",
			);
		}
	});
});
