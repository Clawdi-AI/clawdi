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
	test("acknowledges connect and shared-bot link before starting their requests", () => {
		const connect = source("./connect-bot-dialog.tsx");
		const link = source("./link-agent-dialog.tsx");

		expectFeedbackBeforeRequest(connect, "setSubmitting(true)", "await create.execute(body)");
		expectFeedbackBeforeRequest(link, "setSubmitting(true)", "await link.execute(agentId)");
		expect(connect).toContain('{isSubmitting ? "Close" : "Cancel"}');
		expect(link).toContain('{isSubmitting ? "Close" : "Cancel"}');
		expect(connect).not.toContain("channelDialogOpenChangeAllowed");
		expect(link).not.toContain("channelDialogOpenChangeAllowed");
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

	test("uses per-action feedback for detail-page mutations", () => {
		const detail = source("./channel-detail-page.tsx");

		for (const [feedback, request] of [
			["setRemoving(true)", "await del.mutateAsync(id)"],
			["setUnlinkingLinks((prev)", "await unlink.mutateAsync(linkId)"],
			["setCreatingCredential(true)", "await create.execute"],
			["setRevokingCredentials((prev)", "await revoke.mutateAsync"],
			["setSyncing(true)", "await sync.mutateAsync"],
		] as const) {
			expectFeedbackBeforeRequest(detail, feedback, request);
		}
		expect(detail).toContain("const isUnlinking = unlinkingLinks.has(link.id)");
		expect(detail).toContain("revokingCredentials.has(d.credential_id)");
	});
});
