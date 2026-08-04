import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsSection } from "@/components/settings-section";

describe("SettingsSection", () => {
	test("labels the section with an accessible heading at the requested level", () => {
		const markup = renderToStaticMarkup(
			<SettingsSection
				headingLevel={3}
				title={
					<>
						<span aria-hidden>◆</span> Activity
					</>
				}
			>
				<p>Recent transactions</p>
			</SettingsSection>,
		);
		const titleId = markup.match(/aria-labelledby="([^"]+)"/)?.[1];
		expect(titleId).toBeTruthy();
		expect(markup).toContain(`<h3 id="${titleId}"`);
		expect(markup).toContain("◆");
	});
});
