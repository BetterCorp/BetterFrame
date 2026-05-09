/**
 * Parse input with the given schema. Throws ValidationError on failure.
 */
export function parse(schema, input) {
    return schema.parse(input);
}
/**
 * Parse input with the given schema. Returns a result object.
 */
export function safeParse(schema, input) {
    return schema.safeParse(input);
}
//# sourceMappingURL=parser.js.map