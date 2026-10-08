import {
	Component,
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useRef,
	useState,
} from "react";
import { Modal } from "react-native";
import type { PurchasesOffering } from "react-native-purchases";
import RevenueCatUI from "react-native-purchases-ui";
import { AppView } from "@/components/ui/view";
import {
	createPaywallSession,
	type PaywallSession,
	type PaywallSessionOptions,
} from "./paywall-session";

export type PresentPaywall = (
	offering: PurchasesOffering,
	signal: AbortSignal,
	options?: PaywallSessionOptions,
) => PaywallSession;
const PaywallContext = createContext<PresentPaywall | null>(null);

/** A missing native PaywallView (for example an outdated dev client) throws during render. */
class PaywallBoundary extends Component<
	{ children: ReactNode; onError: () => void },
	{ failed: boolean }
> {
	state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	componentDidCatch() {
		this.props.onError();
	}
	render() {
		return this.state.failed ? null : this.props.children;
	}
}

/** Hosts the official RevenueCat Paywall. M1 serializes presentations through its SDK queue. */
export function PaywallHost({ children }: { children: ReactNode }) {
	const sequence = useRef(0);
	const [active, setActive] = useState<{
		id: number;
		offering: PurchasesOffering;
		session: PaywallSession;
	} | null>(null);
	const present = useCallback<PresentPaywall>((offering, signal, options) => {
		sequence.current += 1;
		const id = sequence.current;
		const session = createPaywallSession(
			signal,
			() => setActive((current) => (current?.id === id ? null : current)),
			undefined,
			options,
		);
		if (!signal.aborted) setActive({ id, offering, session });
		return session;
	}, []);
	return (
		<PaywallContext.Provider value={present}>
			{children}
			<Modal
				visible={active !== null}
				animationType="slide"
				onRequestClose={() => active?.session.requestClose()}
			>
				<AppView className="flex-1 bg-background">
					{active ? (
						<PaywallBoundary key={active.id} onError={active.session.failRender}>
							<RevenueCatUI.Paywall
								// V2 templates ignore this; their close button is owner-configured.
								options={{ offering: active.offering, displayCloseButton: true }}
								{...active.session.listeners}
							/>
						</PaywallBoundary>
					) : null}
				</AppView>
			</Modal>
		</PaywallContext.Provider>
	);
}

export function usePaywall(): PresentPaywall | null {
	return useContext(PaywallContext);
}
