import { useI18n } from "../../i18n";
import { ClerkAction } from "./clerk-form";
/** Secondary credential actions use the same presentation in production and the dev story. */
export function AuthCredentialSecondaryActions({
	signingUp,
	busy,
	validEmail,
	onVault,
	onEmailCode,
	onForgotPassword,
}: {
	signingUp: boolean;
	busy: boolean;
	validEmail: boolean;
	onVault: () => void;
	onEmailCode: () => void;
	onForgotPassword: () => void;
}) {
	const t = useI18n();
	return (
		<>
			<ClerkAction label={t("vault.supplyTitle")} disabled={busy} onPress={onVault} />
			{!signingUp ? (
				<>
					<ClerkAction
						label={t("auth.signInWithEmailCode")}
						disabled={busy || !validEmail}
						onPress={onEmailCode}
					/>
					<ClerkAction
						label={t("auth.forgotPassword")}
						disabled={busy}
						onPress={onForgotPassword}
					/>
				</>
			) : null}
		</>
	);
}
