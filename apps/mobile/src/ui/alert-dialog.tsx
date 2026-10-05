import { alertDialogClasses as styles } from "@clawdi/shared/ui";
import { createContext, type ReactNode, useContext } from "react";
import { Button, type ButtonProps } from "./button";
import {
	ModalControl,
	type ModalControlProps,
	ModalRoot,
	type ModalRootProps,
	ModalSurface,
} from "./modal";
import { WebContent, WebText, WebView } from "./web-layout";

const AlertDialogSizeContext = createContext<"default" | "sm">("default");

type SlotProps = { children?: ReactNode; className?: string };
export function AlertDialog(props: ModalRootProps) {
	return <ModalRoot {...props} />;
}
export function AlertDialogTrigger(props: ModalControlProps) {
	return <ModalControl {...props} />;
}
export function AlertDialogPortal({ children }: SlotProps) {
	return children;
}
export function AlertDialogOverlay(_props: SlotProps) {
	return null;
}
/** Card-styled native Modal keeps asynchronous confirmations visible until accepted. */
export function AlertDialogContent({
	children,
	className,
	size = "default",
}: SlotProps & { size?: "default" | "sm" }) {
	return (
		<AlertDialogSizeContext.Provider value={size}>
			<ModalSurface
				recipe={styles.alertDialogContent}
				overlayRecipe={styles.alertDialogOverlay}
				state={{ [`data-[size=${size}]`]: true }}
				className={className}
				dismissible={false}
			>
				<WebView
					recipe={styles.alertDialogContent
						.split(/\s+/)
						.filter((token) => token.startsWith("gap-"))
						.join(" ")}
				>
					{children}
				</WebView>
			</ModalSurface>
		</AlertDialogSizeContext.Provider>
	);
}
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
	const small = useContext(AlertDialogSizeContext) === "sm";
	return (
		<WebView
			recipe={styles.alertDialogFooter}
			state={{ "group-data-[size=sm]/alert-dialog-content": small }}
			className={className}
			style={small ? { flexDirection: "row" } : undefined}
		>
			{children}
		</WebView>
	);
}
export function AlertDialogMedia({ children, className }: SlotProps) {
	return (
		<WebView recipe={styles.alertDialogMedia} className={className}>
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
export function AlertDialogCancel({ variant = "outline", ...props }: ModalControlProps) {
	return <ModalControl close variant={variant} {...props} />;
}
