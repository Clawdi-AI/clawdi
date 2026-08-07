import { useEffect, useLayoutEffect } from "react";

/**
 * Layout effect on the client, passive effect during SSR — avoids the
 * "useLayoutEffect does nothing on the server" warning while keeping
 * pre-paint semantics where they matter (hydration-safe DOM/title sync).
 */
export const useIsomorphicLayoutEffect =
	typeof window === "undefined" ? useEffect : useLayoutEffect;
