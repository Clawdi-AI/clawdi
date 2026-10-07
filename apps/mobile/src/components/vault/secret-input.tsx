import {
	inputGroupAddonVariants,
	inputGroupButtonVariants,
	inputGroupClasses,
	vaultRequestClasses,
} from "@clawdi/shared/ui";
import { VAULT_REQUEST_COPY } from "@clawdi/shared/view";
import { Eye, EyeOff } from "lucide-react-native";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { WebView, webBoth, webView } from "@/components/ui/web-layout";
import { useI18n } from "@/lib/i18n";

/** Native rendering of SecretInput in Web's VaultRequestPage. */
export function SecretInput({
	label,
	value,
	onChange,
	disabled,
	maxLength,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	disabled?: boolean;
	maxLength?: number;
}) {
	const t = useI18n();
	const [visible, setVisible] = useState(false);
	const multiline = /[\r\n]/.test(value);
	return (
		<WebView
			recipe={inputGroupClasses.root}
			className="flex-row"
			state={{ "has-[>textarea]": visible }}
		>
			<Input
				accessibilityLabel={label}
				autoComplete="off"
				autoCapitalize="none"
				autoCorrect={false}
				textContentType="none"
				editable={!disabled && (visible || !multiline)}
				maxLength={maxLength}
				value={!visible && multiline ? "" : value}
				onChangeText={onChange}
				secureTextEntry={!visible}
				multiline={visible}
				placeholder={!visible && multiline ? VAULT_REQUEST_COPY.multiline : undefined}
				className={webBoth(
					`${visible ? inputGroupClasses.textarea : inputGroupClasses.input} ${vaultRequestClasses.secretInput}`,
				)}
			/>
			<WebView recipe={inputGroupAddonVariants({ align: "inline-end" })}>
				<Button
					variant="ghost"
					className={webView(inputGroupButtonVariants({ size: "icon-xs" }))}
					accessibilityLabel={`${visible ? t("labels.hide") : t("labels.show")} ${label}`}
					accessibilityState={{ checked: visible }}
					disabled={disabled}
					onPress={() => setVisible((current) => !current)}
				>
					<Icon as={visible ? EyeOff : Eye} />
				</Button>
			</WebView>
		</WebView>
	);
}
