import { BaseSchema, ABSENT } from "./base.js";
export class OptionalSchema extends BaseSchema {
    /** @internal */ _inner;
    /** @internal */ _isOptionalWrapper = true;
    constructor(inner) {
        super();
        this._inner = inner;
        // Inherit defaults/coercion from inner
        this._defaultValue = inner._defaultValue;
        this._coercionConfig = inner._coercionConfig;
    }
    _validate(input, ctx) {
        if (input === undefined || input === ABSENT) {
            return undefined;
        }
        return this._inner._validate(input, ctx);
    }
    _runPipeline(input, ctx) {
        const isAbsent = input === undefined || input === ABSENT;
        // If absent and we have a default from inner, apply it
        if (isAbsent && this._inner._defaultValue !== ABSENT) {
            return this._inner._runPipeline(input, ctx);
        }
        if (isAbsent) {
            return undefined;
        }
        // Delegate to inner's pipeline for coercion etc.
        return this._inner._runPipeline(input, ctx);
    }
    _toNode() {
        const node = {
            kind: "optional",
            inner: this._inner._toNode(),
        };
        this._addDefault(node);
        return node;
    }
}
//# sourceMappingURL=optional.js.map