import { BaseSchema } from "./base.js";
import { ISSUE_CODES } from "../issue-codes.js";
import { describeType } from "../util.js";
export class TupleSchema extends BaseSchema {
    _items;
    constructor(items) {
        super();
        this._items = items;
    }
    _validate(input, ctx) {
        if (!Array.isArray(input)) {
            ctx.issues.push({
                code: ISSUE_CODES.INVALID_TYPE,
                message: `Expected tuple, received ${describeType(input)}`,
                path: [...ctx.path],
                expected: "tuple",
                received: describeType(input),
            });
            return undefined;
        }
        if (input.length < this._items.length) {
            ctx.issues.push({
                code: ISSUE_CODES.TOO_SMALL,
                message: `Tuple must have exactly ${this._items.length} element(s), received ${input.length}`,
                path: [...ctx.path],
                expected: String(this._items.length),
                received: String(input.length),
            });
            return undefined;
        }
        if (input.length > this._items.length) {
            ctx.issues.push({
                code: ISSUE_CODES.TOO_LARGE,
                message: `Tuple must have exactly ${this._items.length} element(s), received ${input.length}`,
                path: [...ctx.path],
                expected: String(this._items.length),
                received: String(input.length),
            });
            return undefined;
        }
        const result = [];
        for (let i = 0; i < this._items.length; i++) {
            ctx.path.push(i);
            const val = this._items[i]._runPipeline(input[i], ctx);
            result.push(val);
            ctx.path.pop();
        }
        return result;
    }
    _toNode() {
        const node = {
            kind: "tuple",
            elements: this._items.map((s) => s._toNode()),
        };
        this._addDefault(node);
        return node;
    }
}
//# sourceMappingURL=tuple.js.map