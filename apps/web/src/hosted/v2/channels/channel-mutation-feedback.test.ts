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
		expect(detail).toContain("unlinking={unlinkingLinkIds.has(l.id)}");
		expect(detail).toContain('linkingAccountId === selectedReadyBotId ? "Linking…" : "Link bot"');
		expect(detail).toContain('{creatingPairCode ? "Creating code…" : "Create pairing code"}');
	});

	test("uses per-action feedback for detail-page mutations", () => {
		const detail = source("./channel-detail-page.tsx");

		for (const [feedback, request] of [
			["setRemoving(true)", "await del.mutateAsync(id)"],
			["setRotatingLinks((prev)", "await api.POST"],
			["setUnlinkingLinks((prev)", "await unlink.mutateAsync(linkId)"],
			["setCreatingCredential(true)", "await create.execute"],
			["setRevokingCredentials((prev)", "await revoke.mutateAsync"],
			["setGenerating(true)", "await create.execute"],
			["setSyncing(true)", "await sync.mutateAsync"],
		] as const) {
			expectFeedbackBeforeRequest(detail, feedback, request);
		}
		expect(detail).toContain("const isRotating = rotatingLinks.has(link.id)");
		expect(detail).toContain("const isUnlinking = unlinkingLinks.has(link.id)");
		expect(detail).toContain("revokingCredentials.has(d.credential_id)");
	});
});
