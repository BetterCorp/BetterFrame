import { BaseSchema } from "./base.js";
import { ISSUE_CODES } from "../issue-codes.js";
import { describeType } from "../util.js";
export class ArraySchema extends BaseSchema {
    _items;
    _minItems;
    _maxItems;
    constructor(items) {
        super();
        this._items = items;
    }
    minItems(n) {
        const clone = this._clone();
        clone._minItems = n;
        return clone;
    }
    maxItems(n) {
        const clone = this._clone();
        clone._maxItems = n;
        return clone;
    }
    _validate(input, ctx) {
        if (!Array.isArray(input)) {
            ctx.issues.push({
                code: ISSUE_CODES.INVALID_TYPE,
                message: `Expected array, received ${describeType(input)}`,
                path: [...ctx.path],
                expected: "array",
                received: describeType(input),
            });
            return undefined;
        }
        if (this._minItems !== undefined && input.length < this._minItems) {
            ctx.issues.push({
                code: ISSUE_CODES.TOO_SMALL,
                message: `Array must have at least ${this._minItems} item(s)`,
                path: [...ctx.path],
                expected: String(this._minItems),
                received: String(input.length),
            });
        }
        if (this._maxItems !== undefined && input.length > this._maxItems) {
            ctx.issues.push({
                code: ISSUE_CODES.TOO_LARGE,
                message: `Array must have at most ${this._maxItems} item(s)`,
                path: [...ctx.path],
                expected: String(this._maxItems),
                received: String(input.length),
            });
        }
        const result = [];
        for (let i = 0; i < input.length; i++) {
            ctx.path.push(i);
            const val = this._items._runPipeline(input[i], ctx);
            result.push(val);
            ctx.path.pop();
        }
        return result;
    }
    _toNode() {
        const node = {
            kind: "array",
            items: this._items._toNode(),
        };
        if (this._minItems !== undefined)
            node.minItems = this._minItems;
        if (this._maxItems !== undefined)
            node.maxItems = this._maxItems;
        this._addDefault(node);
        return node;
    }
}
//# sourceMappingURL=array.js.map