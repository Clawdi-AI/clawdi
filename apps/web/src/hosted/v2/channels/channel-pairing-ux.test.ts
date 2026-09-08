import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(relativePath: string): string {
	return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const detail = source("./channel-detail-page.tsx");
const pairDialog = source("./telegram-pair-dialog.tsx");
const connectDialog = source("./connect-bot-dialog.tsx");
const agentDetail = source("../../agents/hosted-agent-detail.tsx");
const pairedChatsDialog = source("./paired-chats-dialog.tsx");

describe("channel credential boundary", () => {
	test("never renders returned runtime credentials", () => {
		for (const ui of [detail, pairDialog, connectDialog, agentDetail, pairedChatsDialog]) {
			expect(ui).not.toContain("TokenReveal");
			expect(ui).not.toContain("agent_token");
			expect(ui).not.toContain("Agent token");
			expect(ui).not.toContain("one-time-secret-value");
		}
	});
});
