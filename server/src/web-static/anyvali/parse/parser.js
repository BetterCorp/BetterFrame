/**
 * Parse input with the given schema. Throws ValidationError on failure.
 */
export function parse(schema, input, options) {
    return schema.parse(input, options);
}
/**
 * Parse input with the given schema. Returns a result object.
 */
export function safeParse(schema, input, options) {
    return schema.safeParse(input, options);
}
//# sourceMappingURL=parser.js.map