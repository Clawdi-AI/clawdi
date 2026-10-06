"use client";

import type { components } from "@clawdi/shared/api";
import { accountAliasDialogClasses } from "@clawdi/shared/ui";
import { connectorFormCopy as copy } from "@clawdi/shared/view";
import { useEffect, useRef, useState } from "react";
import { AccountAliasField } from "@/components/connectors/account-alias-field";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { useUpdateConnectionAlias } from "@/lib/connectors-data";

export function AccountAliasDialog({
	connection,
	onClose,
}: {
	connection: components["schemas"]["ConnectorConnectionResponse"];
	onClose: () => void;
}) {
	const [alias, setAlias] = useState(connection.alias ?? "");
	const [error, setError] = useState<string | null>(null);
	const mutation = useUpdateConnectionAlias();
	const inflightRef = useRef(false);
	const mountedRef = useRef(true);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	async function save() {
		if (inflightRef.current || alias.trim() === (connection.alias ?? "")) return;
		inflightRef.current = true;
		setError(null);
		try {
			await mutation.mutateAsync({
				params: { path: { connection_id: connection.id } },
				body: { alias: alias.trim() },
			});
			if (mountedRef.current) onClose();
		} catch {
			if (mountedRef.current) {
				setError("Couldn't rename account. Try again, or refresh the page if this continues.");
			}
		} finally {
			inflightRef.current = false;
		}
	}

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !inflightRef.current) onClose();
			}}
		>
			<DialogContent className={accountAliasDialogClasses.dialog}>
				<DialogHeader>
					<DialogTitle>{copy.renameTitle}</DialogTitle>
					<DialogDescription className={accountAliasDialogClasses.description}>
						{connection.account_display && connection.account_display !== connection.alias
							? connection.account_display
							: `Account ${connection.id}`}
					</DialogDescription>
				</DialogHeader>
				<form
					className={accountAliasDialogClasses.form}
					onSubmit={(event) => {
						event.preventDefault();
						void save();
					}}
				>
					<AccountAliasField value={alias} onChange={setAlias} disabled={mutation.isPending} />
					{error ? (
						<p role="alert" className={accountAliasDialogClasses.error}>
							{error}
						</p>
					) : null}
					<DialogFooter>
						<Button type="button" variant="outline" disabled={mutation.isPending} onClick={onClose}>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={mutation.isPending || alias.trim() === (connection.alias ?? "")}
						>
							{mutation.isPending ? <Spinner className={accountAliasDialogClasses.icon} /> : null}
							{copy.rename}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
