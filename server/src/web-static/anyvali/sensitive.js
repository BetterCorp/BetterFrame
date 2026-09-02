import { ValidationError } from "./errors.js";
function transformSensitive(schema, data, mode, transform) {
    const result = schema._safeParseWithContext(data, {
        path: [],
        issues: [],
        sensitiveMode: mode,
        sensitiveTransform: transform,
        sensitiveCache: new Map(),
    });
    if (!result.success)
        throw new ValidationError(result.issues);
    return result.data;
}
/** Validate encrypted storage data without decrypting sensitive values. */
export function safeParseEncrypted(schema, data) {
    return schema._safeParseWithContext(data, {
        path: [],
        issues: [],
        sensitiveMode: "encrypted",
    });
}
/** Parse plaintext, transform sensitive values, then validate the encrypted result. */
export function encrypt(schema, data, transform) {
    const encrypted = transformSensitive(schema, schema.parse(data), "encrypt", transform);
    const result = safeParseEncrypted(schema, encrypted);
    if (!result.success)
        throw new ValidationError(result.issues);
    return result.data;
}
/** Validate encrypted data, transform sensitive values, then parse the plaintext result. */
export function decrypt(schema, data, transform) {
    const encrypted = safeParseEncrypted(schema, data);
    if (!encrypted.success)
        throw new ValidationError(encrypted.issues);
    return schema.parse(transformSensitive(schema, encrypted.data, "decrypt", transform));
}
//# sourceMappingURL=sensitive.js.map