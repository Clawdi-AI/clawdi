import { pageMetadata } from "@/app/page-metadata";
import { SettingsShell } from "@/components/settings/settings-shell";

export const metadata = pageMetadata(
	"Settings",
	"Account, AI providers, and billing for Clawdi Cloud.",
);

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
	return <SettingsShell>{children}</SettingsShell>;
}
