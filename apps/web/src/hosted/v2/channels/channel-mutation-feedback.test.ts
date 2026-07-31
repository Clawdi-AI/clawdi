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

		expectFeedbackBeforeRequest(connect, "setSubmitting(true)", "await create.execute(body)");
		expect(connect).toContain('{isSubmitting ? "Close" : "Cancel"}');
		expect(connect).not.toContain("channelDialogOpenChangeAllowed");
	});

	test("keeps agent-page link, unlink, and pair-code feedback scoped to the acting control", () => {
		const detail = source("../../agents/hosted-agent-detail.tsx");
		const pairDialog = source("./telegram-pair-dialog.tsx");
		const pairedChatRow = source("./paired-chat-row.tsx");

		expectFeedbackBeforeRequest(
			detail,
			"setLinkingAccountId(channelId)",
			"await link.execute(channelId)",
		);
		expectFeedbackBeforeRequest(
			detail,
			"setUnlinkingLinkIds((prev) => new Set(prev).add(linkId))",
			"await unlink.mutateAsync",
		);
		expectFeedbackBeforeRequest(detail, "setCreatingPairCode(true)", "await pair.execute");
		expectFeedbackBeforeRequest(pairDialog, "setGenerating(true)", "await pair.execute");
		expect(detail).toContain("unlinking={unlinkingLinkIds.has(l.id)}");
		expect(detail).toContain('linking ? "Linking…" : "Link"');
		expect(detail).toContain('creatingPairCode ? <Spinner className="size-3.5" />');
		expect(detail).toContain('"Generating…"');
		expect(detail).toContain('"Pair Telegram"');
		expect(detail).toContain('"Pair chat"');
		expect(pairDialog).toContain("Creating a secure Telegram link…");
		expect(pairedChatRow).toContain("disabled={unpair.isPending}");
		expect(pairedChatRow).toContain('unpair.isPending ? "Unpairing…"');
		expect(pairedChatRow).toContain('unpair.error ? "Retry unpair"');
	});

	test("uses per-action feedback for bot-owned detail mutations", () => {
		const detail = source("./channel-detail-page.tsx");

		for (const [feedback, request] of [
			["setRemoving(true)", "await del.mutateAsync(id)"],
			["setSyncing(true)", "await sync.mutateAsync"],
		] as const) {
			expectFeedbackBeforeRequest(detail, feedback, request);
		}
		expect(detail).not.toContain("useUnlinkChannelAgent");
		expect(detail).not.toContain("useDeleteChannelBinding");
	});
});
