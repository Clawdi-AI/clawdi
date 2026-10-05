import { dialogClasses as styles } from "@clawdi/shared/ui";
import { X } from "lucide-react-native";
import { type ReactNode, useContext } from "react";
import { useI18n } from "../i18n";
import { Button } from "./button";
import { Icon } from "./icon";
import {
	ModalContext,
	ModalControl,
	type ModalControlProps,
	ModalRoot,
	type ModalRootProps,
	ModalSurface,
} from "./modal";
import { WebText, WebView, webView } from "./web-layout";

type SlotProps = { children?: ReactNode; className?: string };
export function Dialog(props: ModalRootProps) {
	return <ModalRoot {...props} />;
}
export function DialogTrigger(props: ModalControlProps) {
	return <ModalControl {...props} />;
}
export function DialogClose(props: ModalControlProps) {
	return <ModalControl close {...props} />;
}
/** Native Modal owns portal/backdrop; these compatibility slots don't add another layer. */
export function DialogPortal({ children }: SlotProps) {
	return children;
}
export function DialogOverlay(_props: SlotProps) {
	return null;
}
export function DialogContent({
	children,
	className,
	showCloseButton = true,
}: SlotProps & { showCloseButton?: boolean }) {
	const t = useI18n(),
		modal = useContext(ModalContext);
	return (
		<ModalSurface
			recipe={styles.dialogContent}
			overlayRecipe={styles.dialogOverlay}
			className={className}
		>
			<WebView
				recipe={styles.dialogContent
					.split(/\s+/)
					.filter((token) => token.startsWith("gap-"))
					.join(" ")}
			>
				{children}
			</WebView>
			{showCloseButton ? (
				<Button
					variant="ghost"
					size="icon-sm"
					className={webView(styles.dialogContent2)}
					style={{ top: 0, right: 0 }}
					accessibilityLabel={t("composite.close")}
					onPress={() => modal.setOpen(false)}
				>
					<Icon as={X} />
				</Button>
			) : null}
		</ModalSurface>
	);
}
export function DialogHeader({ children, className }: SlotProps) {
	return (
		<WebView recipe={styles.dialogHeader} className={className}>
			{children}
		</WebView>
	);
}
export function DialogFooter({
	children,
	className,
	showCloseButton,
}: SlotProps & { showCloseButton?: boolean }) {
	const t = useI18n();
	return (
		<WebView recipe={styles.dialogFooter} className={className}>
			{children}
			{showCloseButton ? <DialogClose variant="outline">{t("composite.close")}</DialogClose> : null}
		</WebView>
	);
}
export function DialogTitle({ children, className }: SlotProps) {
	return (
		<WebText recipe={styles.dialogTitle} accessibilityRole="header" className={className}>
			{children}
		</WebText>
	);
}
export function DialogDescription({ children, className }: SlotProps) {
	return (
		<WebView recipe={styles.dialogDescription} className={className}>
			{typeof children === "string" ? (
				<WebText recipe={styles.dialogDescription}>{children}</WebText>
			) : (
				children
			)}
		</WebView>
	);
}
