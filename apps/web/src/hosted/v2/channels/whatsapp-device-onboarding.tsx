import { whatsappOnboardingCopy as copy } from "@clawdi/shared/view";

("use client");

import { whatsappDeviceOnboardingClasses } from "@clawdi/shared/ui";

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

export function WhatsAppDeviceOnboarding({
	onDone,
	repairAccountId,
}: {
	onDone: () => void;
	repairAccountId?: string;
}) {
	const [mode, setMode] = useState<WhatsAppConnectMode>("overview");
	const readiness = useWhatsAppOnboardingReadiness(!repairAccountId);

	if (repairAccountId) {
		return (
			<div data-hosted="true" data-v2="true">
				<YourWhatsAppFlow onBack={onDone} onDone={onDone} repairAccountId={repairAccountId} />
			</div>
		);
	}

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
			className={whatsappDeviceOnboardingClasses.flexMinWFlexColGap}
			data-hosted="true"
			data-v2="true"
			data-whatsapp-account-choice
		>
			<p className={whatsappDeviceOnboardingClasses.textXsTextMutedForegroundOverflowWrapAnywhere}>
				Add a WhatsApp account you own by scanning a linked-device QR.
			</p>
			<Alert
				data-whatsapp-account-warning
				className={whatsappDeviceOnboardingClasses.borderWarningBgWarningMutedPy}
			>
				<TriangleAlert aria-hidden />
				<AlertTitle>Use a dedicated number</AlertTitle>
				<AlertDescription className={whatsappDeviceOnboardingClasses.textXs}>
					Clawdi uses WhatsApp’s linked-device feature. When linked to an Agent, replies are sent
					from this account—use a separate number, not your primary personal one.
				</AlertDescription>
			</Alert>
			<p
				className={
					whatsappDeviceOnboardingClasses.minWTextXsTextMutedForegroundOverflowWrapAnywhere
				}
				role="status"
			>
				{readiness.isLoading ? "Checking linked-device availability…" : readinessMessage}
			</p>
			<Button
				type="button"
				className={whatsappDeviceOnboardingClasses.wFullMinWWhitespaceNormalSmWFit}
				disabled={customUnavailable || readiness.isLoading}
				onClick={() => setMode("custom")}
			>
				<QrCode className={whatsappDeviceOnboardingClasses.sizeShrink} />
				Connect your account
			</Button>
			<p className={whatsappDeviceOnboardingClasses.textXsTextMutedForegroundOverflowWrapAnywhere}>
				This adds the account under Custom bots. Agent Link and chat Pair are separate next steps.
			</p>
		</div>
	);
}

function YourWhatsAppFlow({
	onBack,
	onDone,
	repairAccountId,
}: {
	onBack: () => void;
	onDone: () => void;
	repairAccountId?: string;
}) {
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
	const repairStartedRef = useRef(false);
	const mountedRef = useRef(true);
	const cancelSession = actions.cancel.execute;
	const repairAccount = actions.repair.execute;

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
		if (!repairAccountId || repairStartedRef.current) return;
		repairStartedRef.current = true;
		void repairAccount(repairAccountId)
			.then((next) => {
				if (mountedRef.current) {
					setSession(next);
				} else if (whatsappOnboardingRequiresCleanup(next.state)) {
					void cancelSession(next.id).catch(() => undefined);
				}
			})
			.catch(() => {
				if (mountedRef.current) setRequestError(true);
			});
	}, [repairAccount, repairAccountId]);

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

	function retryRepairStart() {
		if (!repairAccountId || actions.repair.isPending) return;
		setRequestError(false);
		void repairAccount(repairAccountId)
			.then((next) => {
				repairStartedRef.current = true;
				if (mountedRef.current) {
					setSession(next);
				} else if (whatsappOnboardingRequiresCleanup(next.state)) {
					void cancelSession(next.id).catch(() => undefined);
				}
			})
			.catch(() => {
				repairStartedRef.current = true;
				if (mountedRef.current) setRequestError(true);
			});
	}

	if (!session) {
		if (repairAccountId) {
			return (
				<div
					className={whatsappDeviceOnboardingClasses.minWSpaceY}
					data-whatsapp-onboarding-state="repairing"
				>
					{requestError ? (
						<>
							<PairingNotice title="Couldn't start WhatsApp repair">
								The connection status may be temporarily unavailable. Your account and history were
								not removed.
							</PairingNotice>
							<PairingDialogActions>
								<Button type="button" variant="outline" onClick={onBack}>
									Close
								</Button>
								<Button
									type="button"
									disabled={actions.repair.isPending}
									onClick={retryRepairStart}
								>
									<RefreshCw className={whatsappDeviceOnboardingClasses.size} />
									Try again
								</Button>
							</PairingDialogActions>
						</>
					) : (
						<CenteredState
							icon={<Spinner className={whatsappDeviceOnboardingClasses.size2} />}
							title="Preparing WhatsApp repair…"
							description="Checking the saved device session before generating a new QR code."
						/>
					)}
				</div>
			);
		}
		return (
			<div
				className={whatsappDeviceOnboardingClasses.minWSpaceY}
				data-whatsapp-onboarding-state="name"
			>
				<button
					type="button"
					className={whatsappDeviceOnboardingClasses.inlineFlexItemsCenterGapTextSm}
					onClick={onBack}
				>
					<ChevronLeft className={whatsappDeviceOnboardingClasses.size} />
					WhatsApp setup
				</button>
				<div className={whatsappDeviceOnboardingClasses.spaceY}>
					<Label htmlFor="whatsapp-account-name">{copy.accountName}</Label>
					<Input
						id="whatsapp-account-name"
						value={name}
						onChange={(event) => setName(event.target.value)}
						placeholder={copy.accountPlaceholder}
						maxLength={120}
						disabled={Boolean(startRequestIdRef.current) || actions.start.isPending}
						autoComplete="off"
					/>
					<p className={whatsappDeviceOnboardingClasses.textXsTextMutedForeground}>
						{copy.nameHint}
					</p>
				</div>
				{requestError ? (
					<PairingNotice title="Couldn't start WhatsApp connection">
						The previous request may still be running. Try again to recover the same request.
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
							<Spinner className={whatsappDeviceOnboardingClasses.size} />
						) : (
							<QrCode className={whatsappDeviceOnboardingClasses.size} />
						)}
						{actions.start.isPending ? "Starting…" : copy.generateQr}
					</Button>
				</PairingDialogActions>
			</div>
		);
	}

	return (
		<div
			className={whatsappDeviceOnboardingClasses.minWSpaceY}
			data-whatsapp-onboarding-state={session.state}
			aria-live="polite"
		>
			<WhatsAppSessionState
				session={session}
				repairing={Boolean(repairAccountId)}
				nowMs={nowMs}
				phoneNumber={phoneNumber}
				onPhoneNumberChange={setPhoneNumber}
				onRequestPairingCode={() => void requestPairingCode()}
				pairingCodePending={actions.pairingCode.isPending}
			/>
			{statusCheckFailed ? (
				<p className={whatsappDeviceOnboardingClasses.textXsTextWarning}>
					Connection status is temporarily unavailable. Clawdi is still checking.
				</p>
			) : null}
			{requestError ? (
				<PairingNotice title="WhatsApp action couldn't be completed">
					Try again. Sensitive pairing details were not included in this error.
				</PairingNotice>
			) : null}
			{session.state === "connected" ? (
				<Button
					type="button"
					className={whatsappDeviceOnboardingClasses.wFullMinWWhitespaceNormal}
					onClick={onDone}
				>
					<Bot className={whatsappDeviceOnboardingClasses.sizeShrink} />
					{repairAccountId ? "Done" : "Review Custom bots"}
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
							<Spinner className={whatsappDeviceOnboardingClasses.size} />
						) : (
							<RefreshCw className={whatsappDeviceOnboardingClasses.size} />
						)}
						Retry
					</Button>
				</PairingDialogActions>
			) : (
				<Button
					type="button"
					variant="outline"
					className={whatsappDeviceOnboardingClasses.wFull}
					disabled={actions.cancel.isPending}
					onClick={() => void cancelAndBack()}
				>
					{actions.cancel.isPending ? (
						<Spinner className={whatsappDeviceOnboardingClasses.size} />
					) : (
						<Unplug className={whatsappDeviceOnboardingClasses.size} />
					)}
					{actions.cancel.isPending ? "Canceling…" : "Cancel connection"}
				</Button>
			)}
		</div>
	);
}

export function WhatsAppSessionState({
	session,
	repairing = false,
	nowMs,
	phoneNumber,
	onPhoneNumberChange,
	onRequestPairingCode,
	pairingCodePending,
}: {
	session: WhatsAppOnboardingSession;
	repairing?: boolean;
	nowMs: number;
	phoneNumber: string;
	onPhoneNumberChange: (value: string) => void;
	onRequestPairingCode: () => void;
	pairingCodePending: boolean;
}) {
	if (session.state === "generating") {
		return (
			<CenteredState
				icon={<Spinner className={whatsappDeviceOnboardingClasses.size2} />}
				title={copy.generating}
			/>
		);
	}
	if (session.state === "scanned") {
		return (
			<CenteredState
				icon={<Spinner className={whatsappDeviceOnboardingClasses.size2} />}
				title={copy.scanned}
				description="Finishing the encrypted WhatsApp connection. Keep this dialog open."
			/>
		);
	}
	if (session.state === "connected") {
		return (
			<CenteredState
				icon={<CheckCircle2 className={whatsappDeviceOnboardingClasses.sizeTextSuccess} />}
				title={copy.connected}
				description={
					repairing
						? "WhatsApp reconnected. Existing Custom bot settings, Agent Links, paired chats, and history remain unchanged."
						: "The account now appears under Custom bots. Link it to an Agent, then pair an authorized chat."
				}
			/>
		);
	}
	if (session.state === "expired") {
		return (
			<CenteredState
				icon={<CircleAlert className={whatsappDeviceOnboardingClasses.sizeTextWarning} />}
				title={copy.expired}
				description="The device session was stopped. Retry to generate a fresh QR code."
			/>
		);
	}
	if (session.state === "canceled") {
		return (
			<CenteredState
				icon={<Unplug className={whatsappDeviceOnboardingClasses.sizeTextMutedForeground} />}
				title={copy.canceled}
			/>
		);
	}
	if (session.state === "error") {
		return (
			<CenteredState
				icon={<CircleAlert className={whatsappDeviceOnboardingClasses.sizeTextDestructive} />}
				title={copy.error}
				description="Clawdi couldn't confirm a safe connection. Retry, or go back to clean it up."
			/>
		);
	}

	if (session.method === "code" && session.pairing_code) {
		return (
			<div className={whatsappDeviceOnboardingClasses.spaceY2}>
				<div>
					<p className={whatsappDeviceOnboardingClasses.textSmFontMedium}>
						Enter this code in your WhatsApp account
					</p>
					<p className={whatsappDeviceOnboardingClasses.mtTextXsTextMutedForeground}>
						WhatsApp &gt; Settings/Menu &gt; Linked devices &gt; Link a device &gt; Link with phone
						number instead.
					</p>
				</div>
				<CopyablePairingCode value={session.pairing_code} label="WhatsApp pairing code" />
				<p className={whatsappDeviceOnboardingClasses.textXsTextMutedForeground}>
					This links the WhatsApp account for the phone number you entered. Keep this page open
					until Clawdi confirms the connection.
				</p>
			</div>
		);
	}

	return (
		<div className={whatsappDeviceOnboardingClasses.spaceY2}>
			{session.qr ? (
				<PairingQrCode value={session.qr} label="WhatsApp linked-device QR code" />
			) : (
				<CenteredState
					icon={<Spinner className={whatsappDeviceOnboardingClasses.size2} />}
					title="Refreshing QR code…"
				/>
			)}
			<PairingExpiry>{whatsappQrExpiryLabel(session.qr_expires_at, nowMs)}</PairingExpiry>
			<PairingInstructionPanel>
				<p className={whatsappDeviceOnboardingClasses.fontMedium}>
					On the WhatsApp account you want to link:
				</p>
				<p className={whatsappDeviceOnboardingClasses.textXsTextMutedForeground}>
					{copy.scanInstruction}
				</p>
				<p className={whatsappDeviceOnboardingClasses.textXsTextMutedForegroundSmHidden}>
					A phone cannot scan a QR shown on the same phone. Open Clawdi on a computer, or use the
					pairing-code fallback below.
				</p>
			</PairingInstructionPanel>
			{session.manual_pairing_code_supported ? (
				<details className={whatsappDeviceOnboardingClasses.roundedLgBorderBgMutedP}>
					<summary className={whatsappDeviceOnboardingClasses.cursorPointerTextSmFontMedium}>
						{copy.fallback}
					</summary>
					<div className={whatsappDeviceOnboardingClasses.mtSpaceY}>
						<p className={whatsappDeviceOnboardingClasses.textXsTextMutedForeground}>
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
							<p className={whatsappDeviceOnboardingClasses.textXsTextDestructive}>
								{whatsappPhoneNumberError(phoneNumber)}
							</p>
						) : null}
						<Button
							type="button"
							variant="outline"
							className={whatsappDeviceOnboardingClasses.wFull}
							disabled={
								!phoneNumber || Boolean(whatsappPhoneNumberError(phoneNumber)) || pairingCodePending
							}
							onClick={onRequestPairingCode}
						>
							{pairingCodePending ? (
								<Spinner className={whatsappDeviceOnboardingClasses.size} />
							) : null}
							{pairingCodePending ? "Requesting…" : copy.requestCode}
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
		<div role="status" className={whatsappDeviceOnboardingClasses.flexMinHFlexColItemsCenter}>
			{icon}
			<p className={whatsappDeviceOnboardingClasses.maxWFullFontMediumOverflowWrapAnywhere}>
				{title}
			</p>
			{description ? (
				<p
					className={
						whatsappDeviceOnboardingClasses.maxWSmTextXsTextMutedForegroundOverflowWrapAnywhere
					}
				>
					{description}
				</p>
			) : null}
		</div>
	);
}
