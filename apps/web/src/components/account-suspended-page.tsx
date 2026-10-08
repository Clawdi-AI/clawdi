import { accountSuspendedPageClasses as styles } from "@clawdi/shared/ui";
import { accountSuspendedCopy as copy, SUPPORT_MAILTO } from "@clawdi/shared/view";
import { LogOut, Mail, ShieldOff } from "lucide-react";
import { ClawdiLogo } from "@/components/clawdi-logo";
import { Button, buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export function AccountSuspendedPage({
	onSignOut,
	signingOut = false,
	signOutError = null,
}: {
	onSignOut: () => void;
	signingOut?: boolean;
	signOutError?: string | null;
}) {
	return (
		<main className={styles.page}>
			<section className={styles.section} aria-labelledby="account-suspended-title">
				<ClawdiLogo alt="Clawdi" className={styles.logo} />
				<div className={styles.iconChip}>
					<ShieldOff className={styles.icon} aria-hidden="true" />
				</div>
				<h1 id="account-suspended-title" className={styles.title}>
					{copy.title}
				</h1>
				<p className={styles.reason}>{copy.reason}</p>
				<p className={styles.help}>{copy.help}</p>
				<div className={styles.actions}>
					<a href={SUPPORT_MAILTO} className={cn(buttonVariants())}>
						<Mail data-icon="inline-start" />
						{copy.contactSupport}
					</a>
					<Button variant="outline" disabled={signingOut} onClick={onSignOut}>
						{signingOut ? (
							<Spinner data-icon="inline-start" aria-label={copy.signingOut} />
						) : (
							<LogOut data-icon="inline-start" />
						)}
						{signingOut ? copy.signingOut : copy.signOut}
					</Button>
				</div>
				{signOutError ? (
					<p className={styles.error} role="alert">
						{signOutError}
					</p>
				) : null}
			</section>
		</main>
	);
}
