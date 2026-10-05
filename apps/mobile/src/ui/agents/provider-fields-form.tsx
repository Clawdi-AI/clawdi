import { AI_PROVIDER_API_MODES } from "@clawdi/shared";
import { API_MODE_LABEL, type ApiMode } from "@clawdi/shared/api";
import {
	inputGroupAddonVariants,
	inputGroupButtonVariants,
	inputGroupClasses,
	providerFieldsFormClasses as styles,
} from "@clawdi/shared/ui";
import { providerFieldsFormCopy as copy } from "@clawdi/shared/view";
import { Eye, EyeOff } from "lucide-react-native";
import { useState } from "react";
import { Button } from "../button";
import { Icon } from "../icon";
import { Input, Label } from "../input";
import { WebView, webBoth, webView } from "../web-layout";
import { ChoiceSelect } from "./controls";

/** Web's name, routing and credential fields, with controlled native inputs. */
export function ProviderFieldsForm({
	label,
	placeholder,
	onLabel,
	showRouting,
	baseUrl,
	onBaseUrl,
	apiMode,
	onApiMode,
	secret,
	onSecret,
	credentialLabel = copy.apiKey,
	credentialPlaceholder = copy.apiKeyPlaceholder,
	disabled,
	oauth,
}: {
	label: string;
	placeholder: string;
	onLabel: (value: string) => void;
	showRouting: boolean;
	baseUrl: string;
	onBaseUrl: (value: string) => void;
	apiMode: ApiMode;
	onApiMode: (value: ApiMode) => void;
	secret: string;
	onSecret: (value: string) => void;
	credentialLabel?: string;
	credentialPlaceholder?: string;
	disabled: boolean;
	oauth?: boolean;
}) {
	const [visible, setVisible] = useState(false);
	return (
		<WebView recipe={styles.root}>
			<WebView recipe={styles.field}>
				<Label>{copy.name}</Label>
				<Input
					accessibilityLabel={copy.name}
					placeholder={placeholder}
					value={label}
					onChangeText={onLabel}
					maxLength={200}
					editable={!disabled}
				/>
			</WebView>
			{showRouting ? (
				<>
					<WebView recipe={styles.field}>
						<Label>{copy.apiFormat}</Label>
						<ChoiceSelect
							value={apiMode}
							options={AI_PROVIDER_API_MODES.map((mode) => ({
								value: mode,
								label: API_MODE_LABEL[mode],
							}))}
							onValueChange={onApiMode}
							disabled={disabled}
						/>
					</WebView>
					<WebView recipe={styles.field}>
						<Label>{copy.endpoint}</Label>
						<Input
							accessibilityLabel={copy.endpoint}
							placeholder={copy.endpointPlaceholder}
							value={baseUrl}
							onChangeText={onBaseUrl}
							maxLength={1000}
							editable={!disabled}
							autoCapitalize="none"
							autoCorrect={false}
						/>
					</WebView>
				</>
			) : null}
			{!oauth ? (
				<WebView recipe={styles.field}>
					<Label>{credentialLabel}</Label>
					<WebView recipe={inputGroupClasses.root} className="flex-row">
						<Input
							accessibilityLabel={credentialLabel}
							placeholder={credentialPlaceholder}
							value={secret}
							onChangeText={onSecret}
							editable={!disabled}
							secureTextEntry={!visible}
							autoCapitalize="none"
							autoCorrect={false}
							className={webBoth(inputGroupClasses.input)}
						/>
						<WebView recipe={inputGroupAddonVariants({ align: "inline-end" })}>
							<Button
								variant="ghost"
								className={webView(inputGroupButtonVariants({ size: "icon-xs" }))}
								accessibilityLabel={`${visible ? "Hide" : "Show"} ${credentialLabel}`}
								accessibilityState={{ checked: visible }}
								disabled={disabled}
								onPress={() => setVisible((value) => !value)}
							>
								<Icon as={visible ? EyeOff : Eye} />
							</Button>
						</WebView>
					</WebView>
				</WebView>
			) : null}
		</WebView>
	);
}
