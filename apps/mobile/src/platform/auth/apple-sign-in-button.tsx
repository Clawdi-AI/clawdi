import {
	AppleAuthenticationButton,
	AppleAuthenticationButtonStyle,
	AppleAuthenticationButtonType,
} from "expo-apple-authentication";
import { useUniwind } from "uniwind";
import { AppView } from "@/components/ui/view";

/**
 * Apple's system button is HIG-approved and localized by iOS; never restyle its
 * background or text. Size and corner radius match the form's `h-9 rounded-md`.
 */
export function AppleSignInButton({
	signingUp,
	disabled,
	onPress,
}: {
	signingUp: boolean;
	disabled: boolean;
	onPress: () => void;
}) {
	const { theme } = useUniwind();
	return (
		<AppView
			className={disabled ? "opacity-50" : undefined}
			pointerEvents={disabled ? "none" : "auto"}
		>
			<AppleAuthenticationButton
				buttonType={
					signingUp ? AppleAuthenticationButtonType.SIGN_UP : AppleAuthenticationButtonType.SIGN_IN
				}
				buttonStyle={
					theme === "dark"
						? AppleAuthenticationButtonStyle.WHITE
						: AppleAuthenticationButtonStyle.BLACK
				}
				cornerRadius={8}
				style={{ width: "100%", height: 36 }}
				onPress={onPress}
			/>
		</AppView>
	);
}
