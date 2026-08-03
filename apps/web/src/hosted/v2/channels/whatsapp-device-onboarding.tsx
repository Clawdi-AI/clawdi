"use client";

import {
	Bot,
	CheckCircle2,
	ChevronLeft,
	CircleAlert,
	QrCode,
	RefreshCw,
	TriangleAlert,
	Unplug,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { WHATSAPP_LINKING_READY } from "@/hosted/v2/channels/channel-linking.logic";
import type { WhatsAppOnboardingSession } from "@/hosted/v2/channels/channel-types";
import {
	useWhatsAppOnboardingActions,
	useWhatsAppOnboardingReadiness,
} from "@/hosted/v2/channels/channels-hooks";
import {
	CopyablePairingCode,
	PairingDialogActions,
	PairingExpiry,
	PairingInstructionPanel,
	PairingNotice,
	PairingQrCode,
} from "@/hosted/v2/channels/pairing-dialog-ui";
import {
	whatsappOnboardingRequiresCleanup,
	whatsappOnboardingShouldPoll,
	whatsappPhoneNumberError,
	whatsappQrExpiryLabel,
	whatsappReadinessMessage,
} from "@/hosted/v2/channels/whatsapp-device-onboarding.logic";

type WhatsAppConnectMode = "overview" | "custom";

export function WhatsAppDeviceOnboarding({ onDone }: { onDone: () => void }) {
	const [mode, setMode] = useState<WhatsAppConnectMode>("overview");
	const readiness = useWhatsAppOnboardingReadiness(true);

	if (mode === "custom") {
		return (
			<div data-hosted="true" data-v2="true">
				<YourWhatsAppFlow onBack={() => setMode("overview")} onDone={onDone} />
			</div>
		);
	}

	const readinessMessage = whatsappReadinessMessage(readiness.data, Boolean(readiness.error));
	const customUnavailable = !readiness.data?.available || Boolean(readiness.error);

	return (
		<div
			className="flex min-w-0 flex-col gap-3"
			data-hosted="true"
			data-v2="true"
			data-whatsapp-account-choice
		>
			<p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
				Add a WhatsApp account you own by scanning a linked-device QR.
			</p>
			<Alert data-whatsapp-account-warning className="border-warning/30 bg-warning-muted py-2.5">
				<TriangleAlert aria-hidden />
				<AlertTitle>Use a dedicated number</AlertTitle>
				<AlertDescription className="text-xs">
					Clawdi uses WhatsApp’s linked-device feature. When linked to an Agent, replies are sent
					from this account—use a separate number, not your primary personal one.
				</AlertDescription>
			</Alert>
			<p className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]" role="status">
				{readiness.isLoading ? "Checking linked-device availability…" : readinessMessage}
			</p>
			<Button
				type="button"
				className="w-full min-w-0 whitespace-normal sm:w-fit"
				disabled={customUnavailable || readiness.isLoading}
				onClick={() => setMode("custom")}
			>
				<QrCode className="size-4 shrink-0" />
				Connect your account
			</Button>
			<p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
				{WHATSAPP_LINKING_READY
					? "This adds the account under Custom bots. Agent Link and chat Pair are separate next steps."
					: "This adds the account under Custom bots. Agent Link and chat Pair remain gated until native runtime activation is enabled."}
			</p>
		</div>
	);
}

function YourWhatsAppFlow({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
	const actions = useWhatsAppOnboardingActions();
	const [name, setName] = useState("");
	const [phoneNumber, setPhoneNumber] = useState("");
	const [session, setSessionState] = useState<WhatsAppOnboardingSession | null>(null);
	const [requestError, setRequestError] = useState(false);
	const [statusCheckFailed, setStatusCheckFailed] = useState(false);
	const [nowMs, setNowMs] = useState(() => Date.now());
	const sessionRef = useRef<WhatsAppOnboardingSession | null>(null);
	const startLockedRef = useRef(false);
	const startRequestIdRef = useRef<string | null>(null);
	const mountedRef = useRef(true);
	const cancelSession = actions.cancel.execute;

	function setSession(next: WhatsAppOnboardingSession | null) {
		sessionRef.current = next;
		setSessionState(next);
	}

	useEffect(() => {
		const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
		return () => window.clearInterval(timer);
	}, []);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			const current = sessionRef.current;
			if (current && whatsappOnboardingRequiresCleanup(current.state)) {
				void cancelSession(current.id).catch(() => undefined);
			}
		};
	}, [cancelSession]);

	useEffect(() => {
		if (!session || !whatsappOnboardingShouldPoll(session.state)) return;
		let disposed = false;
		let timer: number | undefined;
		const poll = async () => {
			try {
				const next = await actions.refresh(session.id);
				if (!disposed) {
					setSession(next);
					setStatusCheckFailed(false);
				}
			} catch {
				if (!disposed) setStatusCheckFailed(true);
			} finally {
				if (!disposed) timer = window.setTimeout(() => void poll(), 2_000);
			}
		};
		timer = window.setTimeout(() => void poll(), 1_200);
		return () => {
			disposed = true;
			if (timer !== undefined) window.clearTimeout(timer);
		};
	}, [actions.refresh, session?.id, session?.state]);

	async function start() {
		if (!name.trim() || actions.start.isPending || startLockedRef.current) return;
		startLockedRef.current = true;
		setRequestError(false);
		try {
			const requestId = startRequestIdRef.current ?? crypto.randomUUID();
			startRequestIdRef.current = requestId;
			const next = await actions.start.execute({
				requestId,
				name: name.trim(),
			});
			if (!mountedRef.current) {
				if (whatsappOnboardingRequiresCleanup(next.state)) {
					await cancelSession(next.id).catch(() => undefined);
				}
				return;
			}
			setSession(next);
		} catch {
			if (mountedRef.current) setRequestError(true);
		} finally {
			startLockedRef.current = false;
		}
	}

	async function requestPairingCode() {
		if (!session || whatsappPhoneNumberError(phoneNumber) || !phoneNumber) return;
		setRequestError(false);
		try {
			const next = await actions.pairingCode.execute({
				sessionId: session.id,
				phoneNumber,
			});
			setPhoneNumber("");
			setSession(next);
		} catch {
			setRequestError(true);
		}
	}

	async function cancelAndBack() {
		if (!session || !whatsappOnboardingRequiresCleanup(session.state)) {
			onBack();
			return;
		}
		try {
			setSession(await cancelSession(session.id));
			onBack();
		} catch {
			setRequestError(true);
		}
	}

	async function retry() {
		if (!session) return;
		setRequestError(false);
		try {
			setSession(await actions.retry.execute(session.id));
		} catch {
			setRequestError(true);
		}
	}

	if (!session) {
		return (
			<div className="min-w-0 space-y-4" data-whatsapp-onboarding-state="name">
				<button
					type="button"
					className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
					onClick={onBack}
				>
					<ChevronLeft className="size-4" />
					WhatsApp setup
				</button>
				<div className="space-y-1.5">
					<Label htmlFor="whatsapp-account-name">Account name</Label>
					<Input
						id="whatsapp-account-name"
						value={name}
						onChange={(event) => setName(event.target.value)}
						placeholder="Personal WhatsApp"
						maxLength={120}
						autoComplete="off"
					/>
					<p className="text-xs text-muted-foreground">
						This names the Custom bot inventory entry. It does not rename your WhatsApp account.
					</p>
				</div>
				{requestError ? (
					<PairingNotice title="Couldn't start WhatsApp connection">
						Try again. No account was added.
					</PairingNotice>
				) : null}
				<PairingDialogActions>
					<Button
						type="button"
						variant="outline"
						disabled={actions.start.isPending}
						onClick={onBack}
					>
						Back
					</Button>
					<Button
						type="button"
						disabled={!name.trim() || actions.start.isPending}
						onClick={() => void start()}
					>
						{actions.start.isPending ? (
							<Spinner className="size-4" />
						) : (
							<QrCode className="size-4" />
						)}
						{actions.start.isPending ? "Starting…" : "Generate QR"}
					</Button>
				</PairingDialogActions>
			</div>
		);
	}

	return (
		<div
			className="min-w-0 space-y-4"
			data-whatsapp-onboarding-state={session.state}
			aria-live="polite"
		>
			<WhatsAppSessionState
				session={session}
				nowMs={nowMs}
				phoneNumber={phoneNumber}
				onPhoneNumberChange={setPhoneNumber}
				onRequestPairingCode={() => void requestPairingCode()}
				pairingCodePending={actions.pairingCode.isPending}
			/>
			{statusCheckFailed ? (
				<p className="text-xs text-warning">
					Connection status is temporarily unavailable. Clawdi is still checking.
				</p>
			) : null}
			{requestError ? (
				<PairingNotice title="WhatsApp action couldn't be completed">
					Try again. Sensitive pairing details were not included in this error.
				</PairingNotice>
			) : null}
			{session.state === "connected" ? (
				<Button type="button" className="w-full min-w-0 whitespace-normal" onClick={onDone}>
					<Bot className="size-4 shrink-0" />
					Review Custom bots
				</Button>
			) : session.state === "expired" || session.state === "error" ? (
				<PairingDialogActions>
					<Button
						type="button"
						variant="outline"
						disabled={actions.cancel.isPending}
						onClick={() => (session.state === "error" ? void cancelAndBack() : onBack())}
					>
						Back
					</Button>
					<Button type="button" disabled={actions.retry.isPending} onClick={() => void retry()}>
						{actions.retry.isPending ? (
							<Spinner className="size-4" />
						) : (
							<RefreshCw className="size-4" />
						)}
						Retry
					</Button>
				</PairingDialogActions>
			) : (
				<Button
					type="button"
					variant="outline"
					className="w-full"
					disabled={actions.cancel.isPending}
					onClick={() => void cancelAndBack()}
				>
					{actions.cancel.isPending ? (
						<Spinner className="size-4" />
					) : (
						<Unplug className="size-4" />
					)}
					{actions.cancel.isPending ? "Canceling…" : "Cancel connection"}
				</Button>
			)}
		</div>
	);
}

export function WhatsAppSessionState({
	session,
	nowMs,
	phoneNumber,
	onPhoneNumberChange,
	onRequestPairingCode,
	pairingCodePending,
}: {
	session: WhatsAppOnboardingSession;
	nowMs: number;
	phoneNumber: string;
	onPhoneNumberChange: (value: string) => void;
	onRequestPairingCode: () => void;
	pairingCodePending: boolean;
}) {
	if (session.state === "generating") {
		return <CenteredState icon={<Spinner className="size-6" />} title="Generating QR code…" />;
	}
	if (session.state === "scanned") {
		return (
			<CenteredState
				icon={<Spinner className="size-6" />}
				title="Device approved"
				description="Finishing the encrypted WhatsApp connection. Keep this dialog open."
			/>
		);
	}
	if (session.state === "connected") {
		return (
			<CenteredState
				icon={<CheckCircle2 className="size-7 text-success" />}
				title="WhatsApp account connected"
				description={
					WHATSAPP_LINKING_READY
						? "It is now under Custom bots, but is not ready on an Agent yet. Next, Link it to an Agent, then Pair an authorized chat."
						: "It is now under Custom bots, but is not ready on an Agent. Agent Link and chat Pair remain gated until native runtime activation is enabled."
				}
			/>
		);
	}
	if (session.state === "expired") {
		return (
			<CenteredState
				icon={<CircleAlert className="size-7 text-warning" />}
				title="Connection expired"
				description="The device session was stopped. Retry to generate a fresh QR code."
			/>
		);
	}
	if (session.state === "canceled") {
		return (
			<CenteredState
				icon={<Unplug className="size-7 text-muted-foreground" />}
				title="Connection canceled"
			/>
		);
	}
	if (session.state === "error") {
		return (
			<CenteredState
				icon={<CircleAlert className="size-7 text-destructive" />}
				title="Couldn't connect WhatsApp"
				description="Clawdi couldn't confirm a safe connection. Retry, or go back to clean it up."
			/>
		);
	}

	if (session.method === "code" && session.pairing_code) {
		return (
			<div className="space-y-3">
				<div>
					<p className="text-sm font-medium">Enter this code in your WhatsApp account</p>
					<p className="mt-1 text-xs text-muted-foreground">
						WhatsApp &gt; Settings/Menu &gt; Linked devices &gt; Link a device &gt; Link with phone
						number instead.
					</p>
				</div>
				<CopyablePairingCode value={session.pairing_code} label="WhatsApp pairing code" />
				<p className="text-xs text-muted-foreground">
					This links the WhatsApp account for the phone number you entered. Keep waiting until
					Clawdi confirms Connected.
				</p>
			</div>
		);
	}

	return (
		<div className="space-y-3">
			{session.qr ? (
				<PairingQrCode value={session.qr} label="WhatsApp linked-device QR code" />
			) : (
				<CenteredState icon={<Spinner className="size-6" />} title="Refreshing QR code…" />
			)}
			<PairingExpiry>{whatsappQrExpiryLabel(session.qr_expires_at, nowMs)}</PairingExpiry>
			<PairingInstructionPanel>
				<p className="font-medium">On the WhatsApp account you want to link:</p>
				<p className="text-xs text-muted-foreground">
					WhatsApp &gt; Settings/Menu &gt; Linked devices &gt; Link a device &gt; scan.
				</p>
				<p className="text-xs text-muted-foreground sm:hidden">
					A phone cannot scan a QR shown on the same phone. Open Clawdi on a computer, or use the
					pairing-code fallback below.
				</p>
			</PairingInstructionPanel>
			{session.manual_pairing_code_supported ? (
				<details className="rounded-lg border bg-muted/10 p-3">
					<summary className="cursor-pointer text-sm font-medium">
						Can&apos;t scan? Use a pairing code
					</summary>
					<div className="mt-3 space-y-2">
						<p className="text-xs text-muted-foreground">
							Enter the phone number for the WhatsApp account you are linking, including country
							code, using digits only.
						</p>
						<Label htmlFor="whatsapp-phone-number">WhatsApp phone number</Label>
						<Input
							id="whatsapp-phone-number"
							inputMode="numeric"
							autoComplete="off"
							value={phoneNumber}
							onChange={(event) => onPhoneNumberChange(event.target.value)}
							placeholder="14155550123"
							aria-invalid={Boolean(whatsappPhoneNumberError(phoneNumber))}
						/>
						{whatsappPhoneNumberError(phoneNumber) ? (
							<p className="text-xs text-destructive">{whatsappPhoneNumberError(phoneNumber)}</p>
						) : null}
						<Button
							type="button"
							variant="outline"
							className="w-full"
							disabled={
								!phoneNumber || Boolean(whatsappPhoneNumberError(phoneNumber)) || pairingCodePending
							}
							onClick={onRequestPairingCode}
						>
							{pairingCodePending ? <Spinner className="size-4" /> : null}
							{pairingCodePending ? "Requesting…" : "Get pairing code"}
						</Button>
					</div>
				</details>
			) : null}
		</div>
	);
}

function CenteredState({
	icon,
	title,
	description,
}: {
	icon: React.ReactNode;
	title: string;
	description?: string;
}) {
	return (
		<div
			role="status"
			className="flex min-h-40 flex-col items-center justify-center gap-2 text-center"
		>
			{icon}
			<p className="max-w-full font-medium [overflow-wrap:anywhere]">{title}</p>
			{description ? (
				<p className="max-w-sm text-xs text-muted-foreground [overflow-wrap:anywhere]">
					{description}
				</p>
			) : null}
		</div>
	);
}
