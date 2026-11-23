// Signals for the built-in UIs (monitor, API documentation): Signal and Req of @bmfk/api plus the
// React hooks they use. The library itself has no React; the hooks live here, next to their users.
// `use()` and `useRequest()` are hooks: call them only while rendering a component, as with any hook.
/* eslint-disable react-hooks/rules-of-hooks -- the hooks are methods, which the rule can't see as hooks */
import { useEffect, useState } from "react";
import { Signal as BaseSignal, Req as BaseReq } from "../../api/src/signal/Signal";

export class Signal<T> extends BaseSignal<T> {
	/** Called with each new subscriber's callback, e.g. to hand it the current state at once. */
	onSubscribe?: (callback: (data: T) => void) => void;

	subscribe(callback: (data: T) => void, id?: string): string {
		const before = this.size;
		const result = super.subscribe(callback, id);
		if (this.size > before) this.onSubscribe?.(callback);
		return result;
	}

	/** The last value invoked while the component is mounted (null before the first one). */
	use(deps: unknown[] = [], onInvoke?: (data: T) => void): T | null {
		const [data, setData] = useState<T | null>(null);
		useEffect(() => {
			const id = this.subscribe(value => {
				setData(() => value);
				onInvoke?.(value);
			});
			return () => {
				this.unsubscribe(id);
			};
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, deps);
		return data;
	}
}

export class Req<T, K> extends BaseReq<T, K> {
	/**
	 * Runs the request on mount (with `initialRequest`) and again on every call of the returned
	 * `request(value)`. Returns [data, request, setData, busy].
	 */
	useRequest(onChange?: ((data: K) => void) | null, initialRequest?: T): [K | null, (value: T) => void, (value: K) => void, boolean] {
		// Wrapped in an object so that asking again with the same value runs the request again.
		const [req, setReq] = useState<{ value: T }>({ value: initialRequest as T });
		const [data, setData] = useState<K | null>(null);
		const [busy, setBusy] = useState(true);

		useEffect(() => {
			let alive = true;
			this.request(req.value)
				.then(r => {
					if (!alive) return;
					setData(() => r);
					setBusy(false);
					onChange?.(r);
				})
				.catch(e => {
					if (!alive) return;
					setBusy(false);
					console.error(`${this.name} failed`, e);
				});
			return () => {
				alive = false;
			};
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, [req]);

		return [
			data,
			(value: T) => {
				setBusy(true);
				setReq({ value });
			},
			(value: K) => {
				setData(() => value);
				setBusy(false);
			},
			busy,
		];
	}
}
