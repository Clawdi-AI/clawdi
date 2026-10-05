import { apiKeysPanelClasses } from "@clawdi/shared/ui";
import { useI18n } from "../../i18n";
import { WebView } from "../web-layout";
import { ClerkInput } from "./clerk-form";
export function AuthFields({
	email,
	password,
	onEmailChange,
	onPasswordChange,
	busy,
	newPassword,
}: {
	email: string;
	password: string;
	onEmailChange: (value: string) => void;
	onPasswordChange: (value: string) => void;
	busy: boolean;
	newPassword: boolean;
}) {
	const t = useI18n();
	return (
		<WebView recipe={apiKeysPanelClasses.form}>
			<ClerkInput
				accessibilityLabel={t("auth.email")}
				placeholder={t("auth.email")}
				autoCapitalize="none"
				editable={!busy}
				autoComplete="email"
				keyboardType="email-address"
				textContentType="emailAddress"
				value={email}
				onChangeText={onEmailChange}
			/>
			<ClerkInput
				accessibilityLabel={t("auth.password")}
				placeholder={t("auth.password")}
				autoCapitalize="none"
				editable={!busy}
				autoComplete={newPassword ? "new-password" : "current-password"}
				textContentType={newPassword ? "newPassword" : "password"}
				secureTextEntry
				value={password}
				onChangeText={onPasswordChange}
			/>
		</WebView>
	);
}
