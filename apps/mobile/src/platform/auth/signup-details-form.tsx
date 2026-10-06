import { apiKeysPanelClasses } from "@clawdi/shared/ui";
import { ClerkInput } from "@/components/auth/clerk-form";
import { WebView } from "@/components/ui/web-layout";
import { useI18n } from "@/lib/i18n";
import type { SignupDetailField, SignupDetails } from "@/platform/auth/signup-details";

export function SignupDetailsForm({
	fields,
	values,
	onChange,
	busy,
}: {
	fields: readonly SignupDetailField[];
	values: SignupDetails;
	onChange: (field: SignupDetailField, value: string) => void;
	busy: boolean;
}) {
	const t = useI18n();
	return (
		<WebView recipe={apiKeysPanelClasses.form}>
			{fields.map((field) => (
				<ClerkInput
					key={field}
					accessibilityLabel={t(`signupDetails.${field}`)}
					placeholder={t(`signupDetails.${field}`)}
					value={values[field]}
					onChangeText={(value) => onChange(field, value)}
					editable={!busy}
					secureTextEntry={field === "password"}
					autoCapitalize={field === "first_name" || field === "last_name" ? "words" : "none"}
					autoCorrect={false}
					autoComplete={
						field === "password"
							? "new-password"
							: field === "email_address"
								? "email"
								: field === "phone_number"
									? "tel"
									: "off"
					}
					keyboardType={
						field === "email_address"
							? "email-address"
							: field === "phone_number"
								? "phone-pad"
								: "default"
					}
				/>
			))}
		</WebView>
	);
}
