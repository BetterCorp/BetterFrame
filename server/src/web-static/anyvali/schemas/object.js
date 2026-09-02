import { BaseSchema, ABSENT } from "./base.js";
import { ISSUE_CODES } from "../issue-codes.js";
import { describeType } from "../util.js";
export class ObjectSchema extends BaseSchema {
    _properties;
    _unknownKeys;
    _unknownKeysExplicit;
    constructor(shape, options) {
        super();
        this._properties = new Map();
        this._unknownKeys = options?.unknownKeys ?? "strip";
        this._unknownKeysExplicit = options?.unknownKeys !== undefined;
        for (const [key, schema] of Object.entries(shape)) {
            // Check if the schema is an OptionalSchema wrapper
            const isOptional = schema._isOptionalWrapper === true;
            this._properties.set(key, {
                schema,
                required: !isOptional,
            });
        }
    }
    unknownKeys(mode) {
        const clone = this._clone();
        clone._unknownKeys = mode;
        clone._unknownKeysExplicit = true;
        return clone;
    }
    _effectiveUnknownKeys(ctx) {
        if (ctx.inheritedUnknownKeys !== undefined)
            return ctx.inheritedUnknownKeys;
        if (ctx.unknownKeys !== undefined)
            return ctx.unknownKeys;
        return this._unknownKeysExplicit ? this._unknownKeys : "strip";
    }
    _exportUnknownKeys() {
        return this._unknownKeysExplicit ? this._unknownKeys : "strip";
    }
    _validate(input, ctx) {
        if (typeof input !== "object" || input === null || Array.isArray(input)) {
            ctx.issues.push({
                code: ISSUE_CODES.INVALID_TYPE,
                message: `Expected object, received ${describeType(input)}`,
                path: [...ctx.path],
                expected: "object",
                received: describeType(input),
            });
            return undefined;
        }
        // Circular reference detection
        if (!ctx.seen)
            ctx.seen = new WeakSet();
        if (ctx.seen.has(input)) {
            ctx.issues.push({
                code: ISSUE_CODES.INVALID_TYPE,
                message: "Circular reference detected",
                path: [...ctx.path],
                expected: "object",
                received: "circular",
            });
            return undefined;
        }
        ctx.seen.add(input);
        const obj = input;
        const result = Object.create(null);
        const inputKeys = new Set(Object.keys(obj));
        // Detect __proto__ via hasOwnProperty (Object.keys skips it)
        if (Object.prototype.hasOwnProperty.call(obj, "__proto__")) {
            inputKeys.add("__proto__");
        }
        // Validate declared properties
        const unknownKeys = this._effectiveUnknownKeys(ctx);
        const previousInheritedUnknownKeys = ctx.inheritedUnknownKeys;
        const previousUnknownKeys = ctx.unknownKeys;
        if (unknownKeys === "strip" || unknownKeys === "reject") {
            ctx.inheritedUnknownKeys = unknownKeys;
        }
        ctx.unknownKeys = undefined;
        for (const [key, prop] of this._properties) {
            ctx.path.push(key);
            const hasKey = Object.prototype.hasOwnProperty.call(obj, key);
            inputKeys.delete(key);
            if (!hasKey) {
                // Check if required
                if (prop.required && prop.schema._defaultValue === ABSENT) {
                    const expectedKind = prop.schema._toNode().kind;
                    ctx.issues.push({
                        code: ISSUE_CODES.REQUIRED,
                        message: `Required property "${key}" is missing`,
                        path: [...ctx.path],
                        expected: expectedKind,
                        received: "undefined",
                    });
                    ctx.path.pop();
                    continue;
                }
            }
            const rawValue = hasKey ? obj[key] : undefined;
            const val = prop.schema._runPipeline(rawValue, ctx);
            // Only include in result if value is not undefined or it was explicitly present
            if (val !== undefined || hasKey || prop.schema._defaultValue !== ABSENT) {
                Object.defineProperty(result, key, {
                    value: val,
                    writable: true,
                    enumerable: true,
                    configurable: true,
                });
            }
            ctx.path.pop();
        }
        ctx.inheritedUnknownKeys = previousInheritedUnknownKeys;
        ctx.unknownKeys = previousUnknownKeys;
        // Handle unknown keys
        for (const key of inputKeys) {
            switch (unknownKeys) {
                case "reject":
                    ctx.issues.push({
                        code: ISSUE_CODES.UNKNOWN_KEY,
                        message: `Unknown key "${key}"`,
                        path: [...ctx.path, key],
                        expected: "undefined",
                        received: key,
                    });
                    break;
                case "allow":
                    Object.defineProperty(result, key, {
                        value: obj[key],
                        writable: true,
                        enumerable: true,
                        configurable: true,
                    });
                    break;
                case "strip":
                    // Just ignore it
                    break;
            }
        }
        // Remove from the ancestor set now that this subtree is fully processed.
        // The guard tracks the current ancestor chain (true cycles), not every
        // object ever seen — otherwise a shared/repeated non-circular reference in
        // sibling positions would be falsely rejected as circular.
        ctx.seen.delete(input);
        // Restore normal prototype so result behaves like a standard object
        // while preventing __proto__ pollution via Object.create(null) above
        Object.setPrototypeOf(result, Object.prototype);
        return result;
    }
    _toNode() {
        const properties = {};
        const required = [];
        for (const [key, prop] of this._properties) {
            properties[key] = prop.schema._toNode();
            if (prop.required) {
                required.push(key);
            }
        }
        const node = {
            kind: "object",
            properties,
            required,
            unknownKeys: this._exportUnknownKeys(),
        };
        this._addDefault(node);
        return node;
    }
}
//# sourceMappingURL=object.js.map