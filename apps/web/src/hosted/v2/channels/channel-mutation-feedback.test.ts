import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(relativePath: string): string {
	return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function expectFeedbackBeforeRequest(contents: string, feedback: string, request: string) {
	const feedbackIndex = contents.indexOf(feedback);
	const requestIndex = contents.indexOf(request, feedbackIndex);
	expect(feedbackIndex).toBeGreaterThanOrEqual(0);
	expect(requestIndex).toBeGreaterThan(feedbackIndex);
}

describe("channel mutation feedback", () => {
	test("acknowledges bot connection before starting its request", () => {
		const connect = source("./connect-bot-dialog.tsx");

		expectFeedbackBeforeRequest(
			connect,
			"setSubmitting(true)",
			"await create.execute(buildBody())",
		);
		expect(connect).toContain('{isSubmitting ? "Close" : "Cancel"}');
		expect(connect).not.toContain("channelDialogOpenChangeAllowed");
	});

	test("keeps agent-page link, unlink, and pair-code feedback scoped to the acting control", () => {
		const detail = source("../../agents/hosted-agent-detail.tsx");
		const discordPairDialog = source("./discord-pair-dialog.tsx");
		const pairDialog = source("./telegram-pair-dialog.tsx");
		const pairingDialogUi = source("./pairing-dialog-ui.tsx");
		const pairedChatRow = source("./paired-chat-row.tsx");
		const clipboardHook = source("../../../hooks/use-copy-to-clipboard.ts");

		expectFeedbackBeforeRequest(
			detail,
			"setLinkingAccountIds((current) => new Set(current).add(channelId))",
			"await link.execute(channelId)",
		);
		expectFeedbackBeforeRequest(
			detail,
			"setUnlinkingLinkIds((prev) => new Set(prev).add(linkId))",
			"await unlink.mutateAsync",
		);
		expectFeedbackBeforeRequest(detail, "setCreatingPairCode(true)", "await pair.execute");
		expectFeedbackBeforeRequest(pairDialog, "setGenerating(true)", "await pair.execute");
		expect(detail).toContain("unlinkingLinkIds.has(linkForBot.id)");
		expect(detail).toContain('linking ? "Linking…" : "Link"');
		expect(detail).toContain('unlinking ? "Unlinking" : "Unlink"');
		expect(detail).toContain("Unlinking…");
		expect(detail).toContain("creatingPairCode ? (");
		expect(detail).toContain('<Spinner className="size-3.5" />');
		expect(detail).toContain('"Generating…"');
		expect(detail).toContain('creatingPairCode ? "Generating…" : "Pair"');
		expect(detail).not.toContain('"Pair Telegram"');
		expect(detail).not.toContain('"Pair Discord"');
		expect(pairDialog).toContain("Creating a secure Telegram link…");
		expect(pairDialog).toContain("useCreatePairCode(accountId, { agentId, toastOnError: false })");
		expectFeedbackBeforeRequest(discordPairDialog, "setPreparing(true)", "await pair.execute");
		expect(discordPairDialog).toContain("Creating a Discord pair code…");
		expect(discordPairDialog).toContain(
			"useCreatePairCode(accountId, { agentId, toastOnError: false })",
		);
		expect(pairDialog).toContain("success: false");
		expect(pairingDialogUi).toContain("success: false");
		expect(clipboardHook).toContain("success?: string | false");
		expect(clipboardHook).toContain("if (toasts.success !== false)");
		expect(clipboardHook).toContain("toast.error(toasts.error ??");
		expect(pairedChatRow).toContain("disabled={unpair.isPending}");
		expect(pairedChatRow).toContain("unpair.isPending ? (");
		expect(pairedChatRow).toContain("Couldn&apos;t unpair · Try again");
		expect(pairedChatRow).toContain("Unpairing…");
		expect(pairedChatRow).toContain('"Unpair"');
		expect(pairedChatRow).not.toContain('"Retry unpair"');
	});

	test("uses per-action feedback for bot-owned detail mutations", () => {
		const detail = source("./channel-detail-page.tsx");

		for (const [feedback, request] of [
			["setRemoving(true)", "await del.mutateAsync({"],
			["setSyncing(true)", "await sync.mutateAsync"],
		] as const) {
			expectFeedbackBeforeRequest(detail, feedback, request);
		}
		expect(detail).not.toContain("useUnlinkChannelAgent");
		expect(detail).not.toContain("useDeleteChannelBinding");
	});
});
