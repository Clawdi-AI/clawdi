import { describe, expect, test } from "bun:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "@/components/ui/button";
import {
	KEEP_AGENT_SETTINGS_LABEL,
	ProviderConflictNotices,
} from "@/hosted/v2/ai-providers/provider-conflict-notice";
import type { ProviderConflictNotice } from "@/hosted/v2/ai-providers/provider-conflicts";

function notice(overrides: Partial<ProviderConflictNotice> = {}): ProviderConflictNotice {
	return {
		providerId: "custom-openrouter",
		runtime: "hermes",
		code: "native_provider_exists",
		removable: true,
		...overrides,
	};
}

function render(
	items: { notice: ProviderConflictNotice; label: string }[],
	options: { keepPending?: boolean; keepDisabled?: boolean } = {},
) {
	return renderToStaticMarkup(
		<ProviderConflictNotices
			items={items}
			keepPending={options.keepPending ?? false}
			keepDisabled={options.keepDisabled ?? false}
			onKeepAgentSettings={() => {}}
		/>,
	);
}

function findButtons(node: ReactNode): ReactElement<{ onClick?: () => void }>[] {
	if (Array.isArray(node)) return node.flatMap(findButtons);
	if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) return [];
	const own = node.type === Button ? [node] : [];
	return [...own, ...findButtons(node.props.children)];
}

describe("ProviderConflictNotices", () => {
	test("renders nothing without conflicts", () => {
		expect(render([])).toBe("");
	});

	test("explains that the agent's own settings won and nothing changed", () => {
		const markup = render([{ notice: notice(), label: "OpenRouter" }]);

		expect(markup).toContain('data-hosted="true"');
		expect(markup).toContain("OpenRouter isn’t applied");
		expect(markup).toContain(
			"The agent’s own Hermes settings already set up this provider, so Clawdi kept them. Nothing was changed.",
		);
		expect(markup).toContain(KEEP_AGENT_SETTINGS_LABEL);
		expect(markup).toContain(
			"To let Clawdi manage it instead, remove it from the agent’s Hermes settings. Clawdi applies it within about 5 minutes.",
		);
		expect(markup).not.toContain("Failed");
		expect(markup).not.toContain('disabled=""');
	});

	test("names the stored key for a credential pool conflict", () => {
		const markup = render([
			{
				notice: notice({ runtime: "openclaw", code: "native_credential_pool_conflict" }),
				label: "Anthropic",
			},
		]);
		expect(markup).toContain(
			"The agent already stores its own key for this provider in OpenClaw, so Clawdi kept it.",
		);
	});

	test("disables the action while a settings change is pending or applying", () => {
		expect(render([{ notice: notice(), label: "OpenRouter" }], { keepPending: true })).toContain(
			'disabled=""',
		);
		expect(render([{ notice: notice(), label: "OpenRouter" }], { keepDisabled: true })).toContain(
			'disabled=""',
		);
	});

	test("points to the provider choices when a single binding cannot be removed", () => {
		const markup = render([{ notice: notice({ removable: false }), label: "OpenRouter" }]);
		expect(markup).not.toContain(KEEP_AGENT_SETTINGS_LABEL);
		expect(markup).toContain("choose another option below and save");
	});

	test("wires the primary action to keep the agent's own settings", () => {
		let kept = 0;
		const tree = ProviderConflictNotices({
			items: [{ notice: notice(), label: "OpenRouter" }],
			keepPending: false,
			keepDisabled: false,
			onKeepAgentSettings: () => {
				kept += 1;
			},
		});
		const buttons = findButtons(tree);
		expect(buttons).toHaveLength(1);
		buttons[0]?.props.onClick?.();
		expect(kept).toBe(1);
	});
});
