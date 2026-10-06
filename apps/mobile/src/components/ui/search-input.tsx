import {
	inputGroupAddonVariants,
	inputGroupButtonVariants,
	inputGroupClasses as styles,
} from "@clawdi/shared/ui";
import { Search, X } from "lucide-react-native";
import { useI18n } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { WebView, webView } from "@/components/ui/web-layout";
/** Web InputGroup composition; TextInput change supplies the text directly. */
export function SearchInput({
	id,
	value,
	onChange,
	placeholder,
	ariaLabel,
	className,
	autoFocus,
	maxLength,
}: {
	id?: string;
	value: string;
	onChange: (next: string) => void;
	placeholder?: string;
	name?: string;
	ariaLabel?: string;
	className?: string;
	autoFocus?: boolean;
	maxLength?: number;
}) {
	const t = useI18n();
	return (
		<WebView recipe={styles.root} className={className}>
			<WebView recipe={inputGroupAddonVariants({ align: "inline-start" })}>
				<Icon as={Search} />
			</WebView>
			<Input
				nativeID={id}
				accessibilityLabel={ariaLabel ?? t("composite.search")}
				value={value}
				onChangeText={onChange}
				placeholder={placeholder ?? t("composite.searchPlaceholder")}
				autoFocus={autoFocus}
				maxLength={maxLength}
				autoCorrect={false}
				autoCapitalize="none"
				className={webView(styles.input)}
			/>
			{value ? (
				<WebView recipe={inputGroupAddonVariants({ align: "inline-end" })}>
					<Button
						size="icon-xs"
						variant="ghost"
						onPress={() => onChange("")}
						accessibilityLabel={t("composite.clearSearch")}
						className={webView(inputGroupButtonVariants({ size: "icon-xs" }))}
					>
						<Icon as={X} />
					</Button>
				</WebView>
			) : null}
		</WebView>
	);
}
