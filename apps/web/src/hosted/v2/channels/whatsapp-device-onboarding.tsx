"use client";

import { whatsappOnboardingCopy } from "@clawdi/shared/view";
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
			className="flex min-w-0 flex-col gap-3"
			data-hosted="true"
			data-v2="true"
			data-whatsapp-account-choice
		>
			<p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
				{whatsappOnboardingCopy.accountDescription}
			</p>
			<Alert data-whatsapp-account-warning className="border-warning/30 bg-warning-muted py-2.5">
				<TriangleAlert aria-hidden />
				<AlertTitle>{whatsappOnboardingCopy.warningTitle}</AlertTitle>
				<AlertDescription className="text-xs">
					{whatsappOnboardingCopy.warningDescription}
				</AlertDescription>
			</Alert>
			<p className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]" role="status">
				{readiness.isLoading ? whatsappOnboardingCopy.checking : readinessMessage}
			</p>
			<Button
				type="button"
				className="w-full min-w-0 whitespace-normal sm:w-fit"
				disabled={customUnavailable || readiness.isLoading}
				onClick={() => setMode("custom")}
			>
				<QrCode className="size-4 shrink-0" />
				{whatsappOnboardingCopy.connectAccount}
			</Button>
			<p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
				{whatsappOnboardingCopy.accountNextSteps}
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
				<div className="min-w-0 space-y-4" data-whatsapp-onboarding-state="repairing">
					{requestError ? (
						<>
							<PairingNotice title={whatsappOnboardingCopy.repairFailedTitle}>
								{whatsappOnboardingCopy.repairFailed}
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
									<RefreshCw className="size-4" />
									Try again
								</Button>
							</PairingDialogActions>
						</>
					) : (
						<CenteredState
							icon={<Spinner className="size-6" />}
							title="Preparing WhatsApp repair…"
							description="Checking the saved device session before generating a new QR code."
						/>
					)}
				</div>
			);
		}
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
					<Label htmlFor="whatsapp-account-name">{whatsappOnboardingCopy.accountName}</Label>
					<Input
						id="whatsapp-account-name"
						value={name}
						onChange={(event) => setName(event.target.value)}
						placeholder={whatsappOnboardingCopy.accountPlaceholder}
						maxLength={120}
						autoComplete="off"
					/>
					<p className="text-xs text-muted-foreground">{whatsappOnboardingCopy.nameHint}</p>
				</div>
				{requestError ? (
					<PairingNotice title={whatsappOnboardingCopy.startFailedTitle}>
						{whatsappOnboardingCopy.startFailed}
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
						{actions.start.isPending
							? whatsappOnboardingCopy.starting
							: whatsappOnboardingCopy.generateQr}
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
				repairing={Boolean(repairAccountId)}
				nowMs={nowMs}
				phoneNumber={phoneNumber}
				onPhoneNumberChange={setPhoneNumber}
				onRequestPairingCode={() => void requestPairingCode()}
				pairingCodePending={actions.pairingCode.isPending}
			/>
			{statusCheckFailed ? (
				<p className="text-xs text-warning">{whatsappOnboardingCopy.statusCheckFailed}</p>
			) : null}
			{requestError ? (
				<PairingNotice title={whatsappOnboardingCopy.actionFailedTitle}>
					{whatsappOnboardingCopy.actionFailed}
				</PairingNotice>
			) : null}
			{session.state === "connected" ? (
				<Button type="button" className="w-full min-w-0 whitespace-normal" onClick={onDone}>
					<Bot className="size-4 shrink-0" />
					{repairAccountId ? whatsappOnboardingCopy.done : whatsappOnboardingCopy.reviewBots}
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
						{whatsappOnboardingCopy.retry}
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
					{actions.cancel.isPending
						? whatsappOnboardingCopy.canceling
						: whatsappOnboardingCopy.cancelConnection}
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
				icon={<Spinner className="size-6" />}
				title={whatsappOnboardingCopy.generating}
			/>
		);
	}
	if (session.state === "scanned") {
		return (
			<CenteredState
				icon={<Spinner className="size-6" />}
				title={whatsappOnboardingCopy.scanned}
				description={whatsappOnboardingCopy.scannedDescription}
			/>
		);
	}
	if (session.state === "connected") {
		return (
			<CenteredState
				icon={<CheckCircle2 className="size-7 text-success" />}
				title={whatsappOnboardingCopy.connected}
				description={
					repairing
						? whatsappOnboardingCopy.reconnectedDescription
						: whatsappOnboardingCopy.connectedDescription
				}
			/>
		);
	}
	if (session.state === "expired") {
		return (
			<CenteredState
				icon={<CircleAlert className="size-7 text-warning" />}
				title={whatsappOnboardingCopy.expired}
				description={whatsappOnboardingCopy.expiredDescription}
			/>
		);
	}
	if (session.state === "canceled") {
		return (
			<CenteredState
				icon={<Unplug className="size-7 text-muted-foreground" />}
				title={whatsappOnboardingCopy.canceled}
			/>
		);
	}
	if (session.state === "error") {
		return (
			<CenteredState
				icon={<CircleAlert className="size-7 text-destructive" />}
				title={whatsappOnboardingCopy.error}
				description={whatsappOnboardingCopy.errorDescription}
			/>
		);
	}

	if (session.method === "code" && session.pairing_code) {
		return (
			<div className="space-y-3">
				<div>
					<p className="text-sm font-medium">{whatsappOnboardingCopy.codeTitle}</p>
					<p className="mt-1 text-xs text-muted-foreground">{whatsappOnboardingCopy.codeSteps}</p>
				</div>
				<CopyablePairingCode value={session.pairing_code} label="WhatsApp pairing code" />
				<p className="text-xs text-muted-foreground">{whatsappOnboardingCopy.codeHint}</p>
			</div>
		);
	}

	return (
		<div className="space-y-3">
			{session.qr ? (
				<PairingQrCode value={session.qr} label={whatsappOnboardingCopy.qrLabel} />
			) : (
				<CenteredState
					icon={<Spinner className="size-6" />}
					title={whatsappOnboardingCopy.refreshingQr}
				/>
			)}
			<PairingExpiry>{whatsappQrExpiryLabel(session.qr_expires_at, nowMs)}</PairingExpiry>
			<PairingInstructionPanel>
				<p className="font-medium">{whatsappOnboardingCopy.qrHeading}</p>
				<p className="text-xs text-muted-foreground">{whatsappOnboardingCopy.scanInstruction}</p>
				<p className="text-xs text-muted-foreground sm:hidden">
					{whatsappOnboardingCopy.phoneWarning}
				</p>
			</PairingInstructionPanel>
			{session.manual_pairing_code_supported ? (
				<details className="rounded-lg border bg-muted/10 p-3">
					<summary className="cursor-pointer text-sm font-medium">
						{whatsappOnboardingCopy.fallback}
					</summary>
					<div className="mt-3 space-y-2">
						<p className="text-xs text-muted-foreground">{whatsappOnboardingCopy.phoneHint}</p>
						<Label htmlFor="whatsapp-phone-number">{whatsappOnboardingCopy.phoneLabel}</Label>
						<Input
							id="whatsapp-phone-number"
							inputMode="numeric"
							autoComplete="off"
							value={phoneNumber}
							onChange={(event) => onPhoneNumberChange(event.target.value)}
							placeholder={whatsappOnboardingCopy.phonePlaceholder}
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
							{pairingCodePending
								? whatsappOnboardingCopy.requesting
								: whatsappOnboardingCopy.requestCode}
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
