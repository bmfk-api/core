import { test } from "node:test";
import assert from "node:assert/strict";
import { Validator } from "../src/apiServer/helper/Validator";

const model = {
    id: 0,
    name: "", $__name_optional: true,
    status: "", $__status_values: ["new", "paid"],
    amount: 0, $__amount: { min: 1, max: 100 },
    phone: "", $__phone: { regex: "^\\+[0-9]{8,15}$" },
    tags: [""],
    addr: { city: "" },
};
const valid = () => ({ id: 1, status: "new", amount: 5, phone: "+37120000000", tags: ["a"], addr: { city: "Riga" } });
const errors = (o: any) => Validator.validateStructure(model, o);

test("a valid object passes", async () => {
    assert.equal(await errors(valid()), undefined);
});

test("an optional field may be missing", async () => {
    const o: any = valid();
    delete o.name;
    assert.equal(await errors(o), undefined);
});

test("a missing required field is reported by name", async () => {
    const o: any = valid();
    delete o.id;
    assert.deepEqual(await errors(o), ["no field 'id'"]);
});

test("a nested missing field is reported with its path", async () => {
    assert.deepEqual(await errors({ ...valid(), addr: {} }), ["no field 'addr.city'"]);
});

test("a string where a number is expected fails", async () => {
    assert.ok((await errors({ ...valid(), id: "x" }))?.length);
});

test("a value outside $__X_values fails", async () => {
    assert.deepEqual(await errors({ ...valid(), status: "refunded" }), ["wrong value for field 'status'"]);
});

test("min and max bound numbers", async () => {
    assert.ok((await errors({ ...valid(), amount: 0 }))?.[0].includes("too small"));
    assert.ok((await errors({ ...valid(), amount: 101 }))?.[0].includes("too big"));
});

test("regex is enforced", async () => {
    assert.ok((await errors({ ...valid(), phone: "123" }))?.length);
});

test("array items are type-checked", async () => {
    assert.ok((await errors({ ...valid(), tags: [1] }))?.length);
});

test("$__ keys are metadata, not expected fields", async () => {
    const r = await errors(valid());
    assert.equal(r, undefined);
});

test("a bound of 0 is a bound", async () => {
    const m = { n: 0, $__n: { min: 0, max: 10 } };
    assert.ok((await Validator.validateStructure(m, { n: -1 }))?.[0].includes("too small"));
    assert.equal(await Validator.validateStructure(m, { n: 0 }), undefined);
    assert.ok((await Validator.validateStructure({ n: 0, $__n: { max: 0 } }, { n: 3 }))?.[0].includes("too big"));
});

test("min: 0 on a required string still requires a non-empty value", async () => {
    assert.ok((await Validator.validateStructure({ s: "", $__s: { min: 0 } }, { s: "" }))?.length);
});

test("bounds as separate keys: $__x_min / $__x_max", async () => {
    const m = { limit: 0, $__limit_min: 10, $__limit_max: 100, name: "", $__name_min: 3, $__name_max: 5 };
    assert.ok((await Validator.validateStructure(m, { limit: 5, name: "abcd" }))?.[0].includes("too small"));
    assert.ok((await Validator.validateStructure(m, { limit: 500, name: "abcd" }))?.[0].includes("too big"));
    assert.ok((await Validator.validateStructure(m, { limit: 50, name: "ab" }))?.length);
    assert.ok((await Validator.validateStructure(m, { limit: 50, name: "abcdef" }))?.length);
    assert.equal(await Validator.validateStructure(m, { limit: 50, name: "abcd" }), undefined);
});

test("separate-key bound of 0, and the object form wins over separate keys", async () => {
    assert.ok((await Validator.validateStructure({ page: 0, $__page_min: 0 }, { page: -1 }))?.[0].includes("too small"));
    assert.equal(await Validator.validateStructure({ page: 0, $__page_min: 0 }, { page: 0 }), undefined);
    const m = { n: 0, $__n: { min: 1 }, $__n_min: 50 };
    assert.equal(await Validator.validateStructure(m, { n: 2 }), undefined);
});

test("a number sample is only the type, not a bound", async () => {
    assert.equal(await Validator.validateStructure({ amount: 10 }, { amount: 500 }), undefined);
    assert.equal(await Validator.validateStructure({ amount: -5 }, { amount: 1 }), undefined);
    assert.ok((await Validator.validateStructure({ amount: 0, $__amount_max: 10 }, { amount: 11 }))?.[0].includes("too big"));
});

test("numericSamples lists number samples without min/max, nested ones too", () => {
    const m = { a: 10, b: 0, c: 5, $__c_max: 5, d: { e: -3 }, f: [{ g: 7 }], h: "x" };
    assert.deepEqual(Validator.numericSamples(m), ["a (10)", "d.e (-3)", "f.g (7)"]);
});
