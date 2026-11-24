import type { IDBQueryField } from "../DBService";

// A field descriptor (raw SQL, macro options) is recognised by this mark only, never by its shape:
// request data can be shaped like { value, system: true }, and must stay a plain, escaped value.
const DB_FIELD = Symbol("bmfk.dbField");

export type IDBField = IDBQueryField & { readonly [DB_FIELD]: true };

/**
 * A field with options, for REQ_DB `fields`:
 *   updated: dbField("NOW()", { system: true })      // inserted as is: only for SQL written in code
 *   id: dbField(7, { ignoreInUpdate: true })         // left out of @onupdate
 *   name: dbField("CONCAT(@first, ' ', @last)", { system: true, fields: { first, last } })
 *                                                    // nested values are escaped; with system only
 */
export function dbField(value: IDBQueryField["value"], options: Omit<IDBQueryField, "value" | "__parsedValue"> = {}): IDBField {
    return { ...options, value, [DB_FIELD]: true };
}

export function isDBField(v: unknown): v is IDBField {
    return typeof v === "object" && v !== null && (v as any)[DB_FIELD] === true;
}

const OPTION_KEYS = new Set(["value", "name", "system", "ignoreInInsert", "ignoreInUpdate", "useInReplace", "fields", "__parsedValue"]);

/** A plain object with `value` and only option keys: what 6.x and 1.0.x read as field options. */
export function looksLikeFieldOptions(v: unknown): boolean {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return false;
    const keys = Object.keys(v);
    return keys.includes("value") && keys.every(k => OPTION_KEYS.has(k));
}
