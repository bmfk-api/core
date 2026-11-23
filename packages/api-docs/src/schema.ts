/* ------------------------------------------------------------------ */
/* Shared schema helpers                                              */
/*                                                                    */
/* Pure functions over the `parameters` / `returns` trees returned by  */
/* /doc/json. Kept free of JSX so both the documentation renderer and  */
/* the request builder can use them without importing each other.     */
/* ------------------------------------------------------------------ */

export const coloTypes: Record<string, string> = {
	string: "#6aa76a",
	number: "#4c9ec7",
	boolean: "orange",
	object: "#FFAACC",
	array: "#00EEAA",
	any: "#ffeb3b",
	file: "#ff5722",
	date: "#9c27b0",
	null: "#9e9e9e",
	undefined: "#9e9e9e",
};

export const methodColors: Record<string, string> = {
	GET: "#6aa76a",
	POST: "#4c9ec7",
	PUT: "#e0922f",
	DELETE: "#cc4646",
	PATCH: "#9b59b6",
};

// Schema fields (`values`, `default`) may arrive as anything; only primitives are safe
// to render as React children or to drop into a sample payload.
export const isPrimitive = (v: any) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

export const allowedValues = (node: any): any[] => (Array.isArray(node?.values) ? node.values.filter(isPrimitive) : []);

export const sampleValue = (node: any): any => {
	// `values` is an enum — any type with one listed gets a real allowed value in examples.
	const allowed = allowedValues(node);
	if (allowed.length) return allowed[0];

	switch (node?.type) {
		case "string":
			return "string";
		case "number":
			return 0;
		case "boolean":
			return false;
		case "object":
			return sampleFromChilds(node.childs ?? {});
		case "array":
			return node.childs?.["0"] ? [sampleValue(node.childs["0"])] : [];
		case "file":
			return "<binary>";
		case "date":
			return "2026-01-01";
		default:
			return null;
	}
};

export const sampleFromChilds = (childs: any): any => {
	const out: any = {};
	for (const key in childs) out[key] = sampleValue(childs[key]);
	return out;
};

// Children of a schema node. For arrays the element schema lives under childs["0"],
// so its own children are what should be listed.
export const schemaChildren = (node: any): [string, any][] => {
	if (!node || !node.childs) return [];
	if (node.type === "array") {
		const el = node.childs["0"];
		return el && el.childs ? Object.entries(el.childs) : [];
	}
	return Object.entries(node.childs).filter(([k]) => k !== "0");
};

// Element schema of an array node ("0"), or null when the array is untyped.
export const arrayElement = (node: any): any => (node?.type === "array" ? (node.childs?.["0"] ?? null) : null);

/* ------------------------------------------------------------------ */
/* Form value handling                                                */
/* ------------------------------------------------------------------ */

// A blank, schema-shaped value used to seed the request form. Unlike `sampleValue`
// it does NOT invent placeholders — the user must type real data — but it does
// honour `default` and picks the first enum value, since those are real.
export const blankValue = (node: any): any => {
	if (isPrimitive(node?.default)) return node.default;

	const allowed = allowedValues(node);
	if (allowed.length) return allowed[0];

	switch (node?.type) {
		case "object":
			return blankFromChilds(node.childs ?? {});
		case "array":
			return [];
		case "boolean":
			return false;
		default:
			return "";
	}
};

export const blankFromChilds = (childs: any): any => {
	const out: any = {};
	for (const key in childs) {
		if (key === "0") continue;
		out[key] = blankValue(childs[key]);
	}
	return out;
};

// Turn a raw form string into the type the endpoint expects. Invalid numbers are
// passed through untouched so the server (not the form) reports the error.
export const coerce = (raw: any, node: any): any => {
	if (node?.type === "number") {
		if (raw === "" || raw === null || raw === undefined) return undefined;
		const n = Number(raw);
		return Number.isNaN(n) ? raw : n;
	}
	if (node?.type === "boolean") return raw === true || raw === "true";
	return raw;
};

// Build the payload actually sent: coerce every leaf and drop optional fields the
// user left empty, so an untouched form doesn't send a wall of empty strings.
export const buildPayload = (values: any, childs: any): any => {
	const out: any = {};
	for (const key in childs) {
		if (key === "0") continue;
		const node = childs[key];
		const val = values?.[key];

		if (node?.type === "object") {
			const nested = buildPayload(val, node.childs ?? {});
			if (Object.keys(nested).length || !node.optional) out[key] = nested;
			continue;
		}

		if (node?.type === "array") {
			const el = arrayElement(node);
			const items = Array.isArray(val) ? val : [];
			const mapped = items.map(item =>
				el?.type === "object" ? buildPayload(item, el.childs ?? {}) : coerce(item, el),
			);
			if (mapped.length || !node.optional) out[key] = mapped;
			continue;
		}

		const coerced = coerce(val, node);
		const empty = coerced === "" || coerced === undefined;
		if (empty && node?.optional) continue;
		out[key] = empty ? (node?.type === "number" ? 0 : "") : coerced;
	}
	return out;
};

// GET has no body: scalars go to the query string, and nested values are JSON-encoded
// so nothing is silently dropped.
export const buildQuery = (payload: any): string => {
	const parts: string[] = [];
	for (const key in payload) {
		const v = payload[key];
		if (v === undefined || v === null) continue;
		const raw = typeof v === "object" ? JSON.stringify(v) : String(v);
		parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(raw));
	}
	return parts.join("&");
};
