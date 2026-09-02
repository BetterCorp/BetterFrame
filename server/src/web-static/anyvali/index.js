export { ISSUE_CODES } from "./issue-codes.js";
export { ValidationError } from "./errors.js";
export { encrypt, decrypt, safeParseEncrypted } from "./sensitive.js";
// ---- Re-export schema classes ----
export { BaseSchema, ABSENT, StringSchema, NumberSchema, Float32Schema, Float64Schema, IntSchema, Int8Schema, Int16Schema, Int32Schema, Int64Schema, Uint8Schema, Uint16Schema, Uint32Schema, Uint64Schema, BoolSchema, NullSchema, AnySchema, UnknownSchema, NeverSchema, LiteralSchema, EnumSchema, ArraySchema, TupleSchema, ObjectSchema, RecordSchema, UnionSchema, IntersectionSchema, OptionalSchema, NullableSchema, RefSchema, } from "./schemas/index.js";
// ---- Builder functions ----
import { StringSchema } from "./schemas/string.js";
import { NumberSchema, Float32Schema, Float64Schema } from "./schemas/number.js";
import { IntSchema, Int8Schema, Int16Schema, Int32Schema, Int64Schema, Uint8Schema, Uint16Schema, Uint32Schema, Uint64Schema, } from "./schemas/int.js";
import { BoolSchema } from "./schemas/bool.js";
import { NullSchema } from "./schemas/null.js";
import { AnySchema } from "./schemas/any.js";
import { UnknownSchema } from "./schemas/unknown.js";
import { NeverSchema } from "./schemas/never.js";
import { LiteralSchema } from "./schemas/literal.js";
import { EnumSchema } from "./schemas/enum.js";
import { ArraySchema } from "./schemas/array.js";
import { TupleSchema } from "./schemas/tuple.js";
import { ObjectSchema } from "./schemas/object.js";
import { RecordSchema } from "./schemas/record.js";
import { UnionSchema } from "./schemas/union.js";
import { IntersectionSchema } from "./schemas/intersection.js";
import { OptionalSchema } from "./schemas/optional.js";
import { NullableSchema } from "./schemas/nullable.js";
/** Create a string schema */
export function string() {
    return new StringSchema();
}
/** Create a number (float64) schema */
export function number() {
    return new NumberSchema();
}
/** Create a float32 schema */
export function float32() {
    return new Float32Schema();
}
/** Create a float64 schema */
export function float64() {
    return new Float64Schema();
}
/** Create an int (int64) schema */
export function int() {
    return new IntSchema();
}
/** Create an int8 schema */
export function int8() {
    return new Int8Schema();
}
/** Create an int16 schema */
export function int16() {
    return new Int16Schema();
}
/** Create an int32 schema */
export function int32() {
    return new Int32Schema();
}
/** Create an int64 schema */
export function int64() {
    return new Int64Schema();
}
/** Create a uint8 schema */
export function uint8() {
    return new Uint8Schema();
}
/** Create a uint16 schema */
export function uint16() {
    return new Uint16Schema();
}
/** Create a uint32 schema */
export function uint32() {
    return new Uint32Schema();
}
/** Create a uint64 schema */
export function uint64() {
    return new Uint64Schema();
}
/** Create a boolean schema */
export function bool() {
    return new BoolSchema();
}
/** Create a null schema. Named null_ to avoid conflict with the null keyword. */
export function null_() {
    return new NullSchema();
}
/** Create an any schema */
export function any() {
    return new AnySchema();
}
/** Create an unknown schema */
export function unknown() {
    return new UnknownSchema();
}
/** Create a never schema */
export function never() {
    return new NeverSchema();
}
/** Create a literal schema */
export function literal(value) {
    return new LiteralSchema(value);
}
/** Create an enum schema. Named enum_ to avoid conflict with the enum keyword. */
export function enum_(values) {
    return new EnumSchema(values);
}
/** Create an array schema */
export function array(items) {
    return new ArraySchema(items);
}
/** Create a tuple schema */
export function tuple(items) {
    return new TupleSchema(items);
}
/** Create an object schema */
export function object(shape, options) {
    return new ObjectSchema(shape, options);
}
/** Create a record schema */
export function record(valueSchema) {
    return new RecordSchema(valueSchema);
}
/** Create a union schema */
export function union(variants) {
    return new UnionSchema(variants);
}
/** Create an intersection schema */
export function intersection(schemas) {
    return new IntersectionSchema(schemas);
}
/** Wrap a schema as optional */
export function optional(schema) {
    return new OptionalSchema(schema);
}
/** Wrap a schema as nullable */
export function nullable(schema) {
    return new NullableSchema(schema);
}
// ---- Top-level parse functions ----
/** Parse input using the given schema. Throws ValidationError on failure. */
export function parse(schema, input, options) {
    return schema.parse(input, options);
}
/** Parse input using the given schema. Returns a result object. */
export function safeParse(schema, input, options) {
    return schema.safeParse(input, options);
}
// ---- Interchange functions ----
import { exportSchema as _exportSchema } from "./interchange/exporter.js";
import { importSchema as _importSchema } from "./interchange/importer.js";
/** Export a schema to an AnyValiDocument */
export function exportSchema(schema, mode = "portable") {
    return _exportSchema(schema, mode);
}
/** Import an AnyValiDocument to a live schema */
export function importSchema(doc) {
    return _importSchema(doc);
}
//# sourceMappingURL=index.js.map