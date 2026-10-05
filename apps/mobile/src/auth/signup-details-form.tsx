import { useI18n } from "../i18n";
import { AppTextInput, AppView } from "../ui/primitives";
import type { SignupDetailField, SignupDetails } from "./signup-details";

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
		<AppView className="gap-4">
			{fields.map((field) => (
				<AppTextInput
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
					className="rounded-2xl bg-card px-4 py-4 text-base text-foreground"
				/>
			))}
		</AppView>
	);
}
