import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const chooserSource = readFileSync(new URL("./provider-chooser.tsx", import.meta.url), "utf8");
const fieldsSource = readFileSync(new URL("./provider-fields-form.tsx", import.meta.url), "utf8");
const dialogSource = readFileSync(new URL("./add-provider-dialog.tsx", import.meta.url), "utf8");
const providerPageSource = readFileSync(
	new URL("./ai-providers-page.tsx", import.meta.url),
	"utf8",
);
const connectionTestSource = readFileSync(
	new URL("./provider-connection-test.tsx", import.meta.url),
	"utf8",
);
const agentDetailSource = readFileSync(
	new URL("../../agents/hosted-agent-detail.tsx", import.meta.url),
	"utf8",
);
const deployWizardSource = readFileSync(
	new URL("../../billing/deploy/deploy-wizard.tsx", import.meta.url),
	"utf8",
);
const usagePageSource = readFileSync(
	new URL("../../billing/usage/usage-page.tsx", import.meta.url),
	"utf8",
);
const presetsSource = readFileSync(new URL("./provider-presets.ts", import.meta.url), "utf8");
const typesSource = readFileSync(new URL("./provider-types.ts", import.meta.url), "utf8");
const entityIconSource = readFileSync(
	new URL("../../../components/entity-icon.tsx", import.meta.url),
	"utf8",
);

describe("AI provider design-system consistency", () => {
	test("uses the canonical search and entity choice components", () => {
		expect(chooserSource).toContain('import { SearchInput } from "@/components/ui/search-input";');
		expect(chooserSource).not.toContain('from "@/components/ui/input"');
		expect(chooserSource).not.toContain('from "@/components/ui/label"');
		expect(chooserSource).toContain('id="custom_openai_compatible"');
		expect(chooserSource).toContain("<EntityChoiceCard");
		expect(chooserSource).not.toContain("border-dashed");
	});

	test("keeps disclosure controls canonical and Advanced user-collapsible", () => {
		expect(chooserSource).toContain("<ChevronDown");
		expect(fieldsSource).toContain("<ChevronDown");
		expect(chooserSource).not.toContain("⌄");
		expect(fieldsSource).not.toContain("⌄");
		expect(fieldsSource).toContain(
			"const isCustomEndpoint = meta.custom === true && preset === null",
		);
		expect(fieldsSource).toContain("const defaultAdvancedOpen = isCustomEndpoint");
		expect(fieldsSource).toContain("details.open = defaultAdvancedOpen");
		expect(fieldsSource).toContain("ref={initializeAdvancedDetails}");
		expect(fieldsSource).not.toContain("open={meta.custom || isEdit}");
		expect(fieldsSource.indexOf("Advanced")).toBeLessThan(fieldsSource.indexOf("Provider ID"));
		expect(fieldsSource).not.toContain("ProviderTypeChip");
		expect(fieldsSource).not.toContain('kind="provider"');
	});

	test("uses official OpenAI access terminology and honest configure copy", () => {
		expect(fieldsSource).toContain('title="Sign in with ChatGPT"');
		expect(fieldsSource).toContain('description="For subscription access"');
		expect(fieldsSource).toContain('title="Sign in with an API key"');
		expect(fieldsSource).toContain('description="For usage-based access"');
		expect(fieldsSource).toContain(
			"OpenAI bills API key usage through your Platform account at standard API rates.",
		);
		expect(fieldsSource).not.toContain("Codex subscription");
		expect(fieldsSource).not.toContain("metered API billing");
		expect(dialogSource).toContain("meta.custom && selectedPreset === null");
		expect(dialogSource).toContain(
			"Enter the credential and connection details for this custom endpoint.",
		);
		expect(dialogSource).toContain("selectedPreset?.api_key_url ??");
		expect(dialogSource).toContain("meta.apiKeyUrl ??");
	});

	test("routes provider identity through the shared presentation components", () => {
		expect(providerPageSource).toContain("const presentation = providerPresentation(provider)");
		expect(providerPageSource).toContain("<ProviderIcon provider={provider} />");
		expect(deployWizardSource).toContain("<ProviderIcon provider={MANAGED_PROVIDER_ID} />");
		expect(deployWizardSource).toContain("<ProviderIcon provider={provider} />");
		expect(agentDetailSource).toContain("<ProviderIcon provider={MANAGED_PROVIDER_ID} />");
		expect(agentDetailSource).toContain("<ProviderIcon provider={p} />");
		expect(agentDetailSource).toContain(
			"<ProviderIcon provider={unresolvedProviderRef(choice)} />",
		);
		expect(usagePageSource).toContain(
			'<ProviderIcon provider={providerId} providers={providers} size="sm" />',
		);
		expect(agentDetailSource).not.toContain("function selectableCard");
		expect(deployWizardSource).not.toContain("<ProviderTypeChip");
		expect(agentDetailSource).not.toContain("<ProviderTypeChip");
		expect(entityIconSource).toContain("onError={() => setFailed(true)}");
		expect(entityIconSource).not.toContain("models.dev");
		expect(entityIconSource).not.toContain("lobehub");
	});

	test("keeps implementation metadata out of saved cards and chooser taxonomy", () => {
		expect(providerPageSource).not.toContain("provider.base_url");
		expect(providerPageSource).not.toContain("provider.runtime_env_name");
		expect(providerPageSource).not.toContain("API_MODE_LABEL");
		expect(chooserSource).not.toContain("PROVIDER_PRESET_CATEGORIES");
		expect(chooserSource).not.toContain("PROVIDER_PRESET_CATEGORY_LABEL");
		expect(chooserSource).toContain("providerPresetSummary");
		expect(chooserSource).toContain('from "@/hosted/v2/ai-providers/model-binding"');
		expect(presetsSource).not.toContain("function providerPresetSummary");
		expect(presetsSource).not.toContain("website_url");
		expect(presetsSource).not.toContain("ProviderPresetCategory");
		expect(typesSource).not.toContain("tint:");
	});

	test("discloses a possible provider charge before starting a saved-provider test", () => {
		expect(connectionTestSource).toContain("This may incur a small provider");
		expect(connectionTestSource).toContain("Run test");
		expect(connectionTestSource).not.toContain("if (next) runTest()");
		expect(connectionTestSource.indexOf("function changeOpen")).toBeGreaterThan(
			connectionTestSource.indexOf("function runTest"),
		);
	});
});
