import {
	inputGroupAddonVariants,
	inputGroupButtonVariants,
	inputGroupClasses,
	vaultRequestClasses,
} from "@clawdi/shared/ui";
import { VAULT_REQUEST_COPY } from "@clawdi/shared/view";
import { Eye, EyeOff } from "lucide-react-native";
import { useState } from "react";
import { Button } from "../button";
import { Icon } from "../icon";
import { Input } from "../input";
import { WebView, webBoth, webView } from "../web-layout";

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
	const [visible, setVisible] = useState(false);
	const multiline = /[\r\n]/.test(value);
	return (
		<WebView
			recipe={inputGroupClasses.InputGroup}
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
					`${visible ? inputGroupClasses.InputGroupTextarea : inputGroupClasses.InputGroupInput} ${vaultRequestClasses.secretInput}`,
				)}
			/>
			<WebView recipe={inputGroupAddonVariants({ align: "inline-end" })}>
				<Button
					variant="ghost"
					className={webView(inputGroupButtonVariants({ size: "icon-xs" }))}
					accessibilityLabel={`${visible ? "Hide" : "Show"} ${label}`}
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
