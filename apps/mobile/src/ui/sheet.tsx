import { sheetClasses as styles } from "@clawdi/shared/ui";
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
import { WebContent, WebText, WebView, webView } from "./web-layout";

type SlotProps = { children?: ReactNode; className?: string };
export function Sheet(props: ModalRootProps) {
	return <ModalRoot {...props} />;
}
export function SheetTrigger(props: ModalControlProps) {
	return <ModalControl {...props} />;
}
export function SheetClose(props: ModalControlProps) {
	return <ModalControl close {...props} />;
}
export function SheetPortal({ children }: SlotProps) {
	return children;
}
export function SheetOverlay(_props: SlotProps) {
	return null;
}
/** Native Modal slides into Web's requested edge, bounded by safe areas. */
export function SheetContent({
	side = "right",
	children,
	className,
	showCloseButton = true,
}: SlotProps & { side?: "top" | "right" | "bottom" | "left"; showCloseButton?: boolean }) {
	const modal = useContext(ModalContext),
		t = useI18n();
	return (
		<ModalSurface
			side={side}
			recipe={styles.sheetContent}
			overlayRecipe={styles.sheetOverlay}
			state={{ [`data-[side=${side}]`]: true }}
			className={className}
		>
			<WebView
				recipe={styles.sheetContent
					.split(/\s+/)
					.filter((token) => token.startsWith("gap-"))
					.join(" ")}
				className="flex-1"
			>
				{children}
			</WebView>
			{showCloseButton ? (
				<Button
					variant="ghost"
					size="icon-sm"
					className={webView(styles.sheetContent2)}
					accessibilityLabel={t("composite.close")}
					onPress={() => modal.setOpen(false)}
				>
					<Icon as={X} />
				</Button>
			) : null}
		</ModalSurface>
	);
}
export function SheetHeader({ children, className }: SlotProps) {
	return (
		<WebView recipe={styles.sheetHeader} className={className}>
			{children}
		</WebView>
	);
}
export function SheetFooter({ children, className }: SlotProps) {
	return (
		<WebView recipe={styles.sheetFooter} className={className}>
			{children}
		</WebView>
	);
}
export function SheetTitle({ children, className }: SlotProps) {
	return (
		<WebText recipe={styles.sheetTitle} className={className} accessibilityRole="header">
			{children}
		</WebText>
	);
}
export function SheetDescription({ children, className }: SlotProps) {
	return (
		<WebView recipe={styles.sheetDescription} className={className}>
			<WebContent recipe={styles.sheetDescription}>{children}</WebContent>
		</WebView>
	);
}
