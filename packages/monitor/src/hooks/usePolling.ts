import { useEffect, useRef } from "react";

/**
 * Invoke `callback` immediately and then on a fixed interval.
 * The latest callback is always used, so it can safely close over changing state.
 */
export const usePolling = (callback: () => void, intervalMs: number, enabled = true) => {
	const saved = useRef(callback);
	saved.current = callback;

	useEffect(() => {
		if (!enabled) return;
		saved.current();
		const id = setInterval(() => saved.current(), intervalMs);
		return () => clearInterval(id);
	}, [intervalMs, enabled]);
};
