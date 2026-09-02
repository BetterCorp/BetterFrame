import { ValidationError } from "../errors.js";
import { applyCoercion } from "../parse/coerce.js";
import { ISSUE_CODES } from "../issue-codes.js";
const ANYVALI_VERSION = "1.0";
const SCHEMA_VERSION = "1.1";
/**
 * Maximum validation recursion depth. Bounds recursion through recursive
 * `$ref` schemas (and deeply nested data) so a malicious payload cannot
 * exhaust the call stack and crash the process (DoS). Far above any
 * legitimate schema nesting.
 */
export const MAX_DEPTH = 512;
const RESERVED_METADATA_KEYS = new Set([
    'title', 'description', 'deprecated', 'deprecatedMessage',
    'notStable', 'since', 'sensitive', 'readonly', 'writeonly', 'examples',
]);
/** Sentinel for "value not present" */
export const ABSENT = Symbol.for("anyvali.absent");
/**
 * Deep-clone a default value so mutable defaults are isolated per parse.
 * Uses structuredClone when the value is structured-cloneable; falls back to
 * returning the value as-is for things structuredClone cannot handle
 * (e.g. functions), which are not portable defaults anyway.
 */
function cloneDefault(value) {
    if (value === null || typeof value !== "object")
        return value;
    try {
        return structuredClone(value);
    }
    catch {
        return value;
    }
}
export class BaseSchema {
    /** @internal */ _defaultValue = ABSENT;
    /** @internal */ _coercionConfig = undefined;
    /** @internal */ _isPortable = true;
    /** @internal */ _metadata = undefined;
    // ---------- public API ----------
    parse(input, options) {
        const result = this.safeParse(input, options);
        if (result.success)
            return result.data;
        throw new ValidationError(result.issues);
    }
    safeParse(input, options) {
        const ctx = { path: [], issues: [], ...options };
        return this._safeParseWithContext(input, ctx);
    }
    /** @internal */
    _safeParseWithContext(input, ctx) {
        let output;
        try {
            output = this._runPipeline(input, ctx);
        }
        catch (err) {
            // Backstop: the depth guard bounds recursion, but if any path resets
            // the context and exhausts the stack, convert it to a clean issue so
            // safeParse never throws (DoS / contract guarantee).
            if (err instanceof RangeError) {
                return {
                    success: false,
                    issues: [
                        {
                            code: ISSUE_CODES.TOO_DEEP,
                            message: "Maximum validation depth exceeded",
                            path: [],
                            expected: "bounded nesting",
                            received: "too deep",
                        },
                    ],
                };
            }
            throw err;
        }
        if (ctx.issues.length > 0) {
            return { success: false, issues: ctx.issues };
        }
        return { success: true, data: output };
    }
    /** Internal: run the 5-step pipeline */
    _runPipeline(input, ctx) {
        // Depth guard: bound recursion (recursive $ref + deep data) so a crafted
        // payload cannot exhaust the call stack. Return a clean issue instead of
        // letting safeParse throw a RangeError.
        const depth = (ctx.depth ?? 0) + 1;
        if (depth > MAX_DEPTH) {
            ctx.issues.push({
                code: ISSUE_CODES.TOO_DEEP,
                message: `Maximum validation depth of ${MAX_DEPTH} exceeded`,
                path: [...ctx.path],
                expected: `<= ${MAX_DEPTH} levels`,
                received: "too deep",
            });
            return undefined;
        }
        ctx.depth = depth;
        try {
            return this._runPipelineInner(input, ctx);
        }
        finally {
            ctx.depth = depth - 1;
        }
    }
    _runPipelineInner(input, ctx) {
        // Step 1: detect presence
        const isAbsent = input === undefined || input === ABSENT;
        let value = input;
        if (!isAbsent && input !== null && this._metadata?.sensitive === true && ctx.sensitiveMode) {
            if (ctx.sensitiveMode === "encrypted") {
                if (typeof input !== "string") {
                    ctx.issues.push({
                        code: ISSUE_CODES.INVALID_TYPE,
                        message: "Expected encrypted value",
                        path: [...ctx.path],
                        expected: "encrypted:<value>",
                        received: typeof input,
                    });
                    return undefined;
                }
                if (!input.startsWith("encrypted:") || input.length === "encrypted:".length) {
                    ctx.issues.push({
                        code: ISSUE_CODES.INVALID_STRING,
                        message: 'Encrypted value must start with "encrypted:" and contain a payload',
                        path: [...ctx.path],
                        expected: "encrypted:<value>",
                        received: input,
                    });
                    return undefined;
                }
                return input;
            }
            const cacheKey = JSON.stringify(ctx.path);
            if (ctx.sensitiveCache?.has(cacheKey))
                return ctx.sensitiveCache.get(cacheKey);
            if (ctx.sensitiveMode === "encrypt") {
                const checked = this.safeParse(input);
                if (!checked.success) {
                    ctx.issues.push(...checked.issues.map((issue) => ({
                        ...issue,
                        path: [...ctx.path, ...issue.path],
                    })));
                    return undefined;
                }
                value = checked.data;
            }
            const transformed = ctx.sensitiveTransform([...ctx.path], value);
            ctx.sensitiveCache?.set(cacheKey, transformed);
            return transformed;
        }
        // Step 2: coercion (only for present values)
        if (!isAbsent && this._coercionConfig) {
            const coerced = applyCoercion(value, this._coercionConfig, this._getCoercionTarget());
            if (coerced.success) {
                value = coerced.value;
            }
            else {
                ctx.issues.push({
                    code: ISSUE_CODES.COERCION_FAILED,
                    message: coerced.message,
                    path: [...ctx.path],
                    expected: this._getCoercionTarget(),
                    received: String(input),
                });
                return undefined;
            }
        }
        // Step 3: default materialization (only for absent values)
        let usedDefault = false;
        if (isAbsent && this._defaultValue !== ABSENT) {
            // Deep-clone so mutable defaults (arrays/objects) are not shared across
            // parses. Pass-through schemas (any/unknown) return the value by
            // reference, so without cloning a mutation would corrupt the default.
            value = cloneDefault(this._defaultValue);
            usedDefault = true;
        }
        // Step 4: validate
        const issuesBefore = ctx.issues.length;
        const result = this._validate(value, ctx);
        // If default was materialized and validation failed, remap issues to default_invalid
        if (usedDefault && ctx.issues.length > issuesBefore) {
            for (let i = issuesBefore; i < ctx.issues.length; i++) {
                const issue = ctx.issues[i];
                ctx.issues[i] = {
                    ...issue,
                    code: ISSUE_CODES.DEFAULT_INVALID,
                };
            }
        }
        return result;
    }
    /** Override in subclasses to provide the coercion target type name */
    _getCoercionTarget() {
        return "unknown";
    }
    // optional() and nullable() are provided via standalone functions
    // to avoid circular imports. See index.ts.
    default(value) {
        const clone = this._clone();
        clone._defaultValue = value;
        return clone;
    }
    coerce(options = {}) {
        const clone = this._clone();
        clone._coercionConfig = { ...options };
        return clone;
    }
    describe(description, opts) {
        const reservedMeta = this._validateDescribeOpts(description, opts);
        const clone = this._clone();
        clone._metadata = { ...(clone._metadata || {}), ...reservedMeta };
        return clone;
    }
    metadata(meta, opts) {
        // Validate no reserved keys
        for (const key of Object.keys(meta)) {
            if (RESERVED_METADATA_KEYS.has(key)) {
                throw new Error(`metadata(): "${key}" is a reserved key. Use describe() instead.`);
            }
        }
        const clone = this._clone();
        if (opts?.replace) {
            // Replace mode: keep only reserved keys from existing, add new non-reserved
            const existing = clone._metadata || {};
            const reserved = {};
            for (const [k, v] of Object.entries(existing)) {
                if (RESERVED_METADATA_KEYS.has(k)) {
                    reserved[k] = v;
                }
            }
            clone._metadata = { ...reserved, ...meta };
        }
        else {
            // Merge mode (default): shallow merge
            clone._metadata = { ...(clone._metadata || {}), ...meta };
        }
        return clone;
    }
    export(mode = "portable") {
        if (mode === "portable" && !this._isPortable) {
            throw new Error("Cannot export in portable mode: schema contains non-portable features");
        }
        const node = this._toNode();
        return {
            anyvaliVersion: ANYVALI_VERSION,
            schemaVersion: SCHEMA_VERSION,
            root: node,
            definitions: {},
            extensions: {},
        };
    }
    // ---------- internal helpers ----------
    _validateDescribeOpts(description, opts) {
        const meta = { description };
        if (typeof description !== 'string') {
            throw new Error('describe(): description must be a string');
        }
        if (opts) {
            if (opts.title !== undefined) {
                if (typeof opts.title !== 'string')
                    throw new Error('describe(): title must be a string');
                meta.title = opts.title;
            }
            if (opts.deprecated !== undefined) {
                if (typeof opts.deprecated !== 'boolean')
                    throw new Error('describe(): deprecated must be a boolean');
                meta.deprecated = opts.deprecated;
            }
            if (opts.deprecatedMessage !== undefined) {
                if (typeof opts.deprecatedMessage !== 'string')
                    throw new Error('describe(): deprecatedMessage must be a string');
                if (!opts.deprecated)
                    throw new Error('describe(): deprecatedMessage requires deprecated to be true');
                meta.deprecatedMessage = opts.deprecatedMessage;
            }
            if (opts.notStable !== undefined) {
                if (typeof opts.notStable !== 'boolean')
                    throw new Error('describe(): notStable must be a boolean');
                meta.notStable = opts.notStable;
            }
            if (opts.since !== undefined) {
                if (typeof opts.since !== 'string')
                    throw new Error('describe(): since must be a string');
                meta.since = opts.since;
            }
            if (opts.sensitive !== undefined) {
                if (typeof opts.sensitive !== 'boolean')
                    throw new Error('describe(): sensitive must be a boolean');
                meta.sensitive = opts.sensitive;
            }
            if (opts.readonly !== undefined) {
                if (typeof opts.readonly !== 'boolean')
                    throw new Error('describe(): readonly must be a boolean');
                meta.readonly = opts.readonly;
            }
            if (opts.writeonly !== undefined) {
                if (typeof opts.writeonly !== 'boolean')
                    throw new Error('describe(): writeonly must be a boolean');
                meta.writeonly = opts.writeonly;
            }
            if (opts.readonly && opts.writeonly) {
                throw new Error('describe(): readonly and writeonly cannot both be true');
            }
            if (opts.examples !== undefined) {
                if (!Array.isArray(opts.examples))
                    throw new Error('describe(): examples must be an array');
                meta.examples = opts.examples;
            }
        }
        return meta;
    }
    _clone() {
        const clone = Object.create(Object.getPrototypeOf(this));
        Object.assign(clone, this);
        return clone;
    }
    _addDefault(node) {
        if (this._defaultValue !== ABSENT) {
            node.default = this._defaultValue;
        }
        if (this._coercionConfig) {
            node.coerce = { ...this._coercionConfig };
        }
        if (this._metadata && Object.keys(this._metadata).length > 0) {
            node.metadata = { ...this._metadata };
        }
        return node;
    }
}
//# sourceMappingURL=base.js.map