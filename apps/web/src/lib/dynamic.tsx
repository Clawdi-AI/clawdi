import { type ComponentType, lazy, Suspense } from "react";

type DynamicLoader<TProps extends object> = () => Promise<
	ComponentType<TProps> | { default: ComponentType<TProps> }
>;

type DynamicOptions = {
	loading?: ComponentType;
	ssr?: boolean;
};

function normalizeModule<TProps extends object>(
	loaded: ComponentType<TProps> | { default: ComponentType<TProps> },
) {
	return typeof loaded === "function" ? { default: loaded } : loaded;
}

export default function dynamic<TProps extends object>(
	loader: DynamicLoader<TProps>,
	options: DynamicOptions = {},
): ComponentType<TProps> {
	const LazyComponent = lazy(async () => normalizeModule(await loader()));
	const Loading = options.loading;

	const DynamicComponent: ComponentType<TProps> = (props: TProps) => {
		return (
			<Suspense fallback={Loading ? <Loading /> : null}>
				<LazyComponent {...props} />
			</Suspense>
		);
	};

	return DynamicComponent;
}
