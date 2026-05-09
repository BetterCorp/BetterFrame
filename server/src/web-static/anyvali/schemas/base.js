import { ValidationError } from "../errors.js";
import { applyCoercion } from "../parse/coerce.js";
import { ISSUE_CODES } from "../issue-codes.js";
const ANYVALI_VERSION = "1.0";
const SCHEMA_VERSION = "1";
/** Sentinel for "value not present" */
export const ABSENT = Symbol.for("anyvali.absent");
export class BaseSchema {
    /** @internal */ _defaultValue = ABSENT;
    /** @internal */ _coercionConfig = undefined;
    /** @internal */ _isPortable = true;
    // ---------- public API ----------
    parse(input) {
        const result = this.safeParse(input);
        if (result.success)
            return result.data;
        throw new ValidationError(result.issues);
    }
    safeParse(input) {
        const ctx = { path: [], issues: [] };
        const output = this._runPipeline(input, ctx);
        if (ctx.issues.length > 0) {
            return { success: false, issues: ctx.issues };
        }
        return { success: true, data: output };
    }
    /** Internal: run the 5-step pipeline */
    _runPipeline(input, ctx) {
        // Step 1: detect presence
        const isAbsent = input === undefined || input === ABSENT;
        let value = input;
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
            value = this._defaultValue;
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
        return node;
    }
}
//# sourceMappingURL=base.js.map