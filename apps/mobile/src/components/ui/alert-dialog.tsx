import { alertDialogClasses as styles } from "@clawdi/shared/ui";
import type { ReactNode } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { WebContent, WebText, WebView } from "@/components/ui/web-layout";

/** Web AlertDialog content slots. Presentation is native: `ConfirmAction` hosts them
 * in an `@expo/ui` BottomSheet; string prompts use `Alert.alert`. */
type SlotProps = { children?: ReactNode; className?: string };
export function AlertDialogHeader({ children, className }: SlotProps) {
	return (
		<WebView
			recipe={styles.alertDialogHeader}
			className={className}
			style={{ alignItems: "center" }}
		>
			{children}
		</WebView>
	);
}
export function AlertDialogFooter({ children, className }: SlotProps) {
	return (
		<WebView recipe={styles.alertDialogFooter} className={className}>
			{children}
		</WebView>
	);
}
export function AlertDialogTitle({ children, className }: SlotProps) {
	return (
		<WebText recipe={styles.alertDialogTitle} accessibilityRole="header" className={className}>
			{children}
		</WebText>
	);
}
export function AlertDialogDescription({ children, className }: SlotProps) {
	return (
		<WebView recipe={styles.alertDialogDescription} className={className}>
			<WebContent recipe={styles.alertDialogDescription}>{children}</WebContent>
		</WebView>
	);
}
export function AlertDialogAction(props: ButtonProps) {
	return <Button {...props} />;
}
