import type { IDBQueryField } from "../DBService";

// A field descriptor (raw SQL, macro options) is recognised by this mark only, never by its shape:
// request data can be shaped like { value, system: true }, and must stay a plain, escaped value.
const DB_FIELD = Symbol("bmfk.dbField");

export type IDBField = IDBQueryField & { readonly [DB_FIELD]: true };

/**
 * A field with options, for REQ_DB `fields`:
 *   updated: dbField("NOW()", { system: true })      // inserted as is: only for SQL written in code
 *   id: dbField(7, { ignoreInUpdate: true })         // left out of @onupdate
 */
export function dbField(value: IDBQueryField["value"], options: Omit<IDBQueryField, "value" | "__parsedValue"> = {}): IDBField {
    return { ...options, value, [DB_FIELD]: true };
}

export function isDBField(v: unknown): v is IDBField {
    return typeof v === "object" && v !== null && (v as any)[DB_FIELD] === true;
}
