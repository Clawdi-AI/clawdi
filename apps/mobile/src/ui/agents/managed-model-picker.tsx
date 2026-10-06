import type { HostedDeployManagedModel } from "@clawdi/shared/api";
import { managedModelPickerClasses as styles } from "@clawdi/shared/ui";
import { aiBindingCopy as copy, managedModelPickerItems } from "@clawdi/shared/view";
import { ApiErrorPanel } from "../api-error-panel";
import { EntityChoiceCard } from "../entity-card";
import { EntityIcon } from "../entity-icon";
import { Label } from "../input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../select";
import { WebView, webView } from "../web-layout";

export function ManagedModelPicker({
	models,
	value,
	onChange,
	disabled,
	error,
	onRetry,
}: {
	models: readonly HostedDeployManagedModel[];
	value: string;
	onChange: (model: string) => void;
	disabled?: boolean;
	error?: unknown;
	onRetry: () => void;
}) {
	const items = managedModelPickerItems(models);
	if (error)
		return <ApiErrorPanel error={error} title={copy.modelsUnavailable} onRetry={onRetry} />;
	return (
		<WebView recipe={styles.root}>
			<Label>{copy.mainModel}</Label>
			<WebView recipe={styles.controls}>
				<WebView recipe={styles.choices}>
					{items.featured.map((item) => (
						<EntityChoiceCard
							key={item.value}
							title={item.label}
							description={item.description}
							icon={<EntityIcon kind="provider" id={item.iconId} size="sm" />}
							variant="compact"
							className={webView(styles.choice)}
							selected={value === item.value}
							disabled={disabled}
							onClick={() => onChange(item.value)}
						/>
					))}
				</WebView>
				{items.overflow.length ? (
					<Select
						value={value}
						disabled={disabled}
						onValueChange={(v) => {
							if (v) onChange(v);
						}}
					>
						<SelectTrigger size="sm" className={webView(styles.trigger)}>
							<SelectValue placeholder={copy.moreModels} />
						</SelectTrigger>
						<SelectContent>
							{items.overflow.map((item) => (
								<SelectItem key={item.value} value={item.value} label={item.label}>
									{item.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				) : null}
			</WebView>
		</WebView>
	);
}
