import { BaseSchema } from "./base.js";
import { ISSUE_CODES } from "../issue-codes.js";
import { describeType } from "../util.js";
export class RecordSchema extends BaseSchema {
    _valueSchema;
    constructor(valueSchema) {
        super();
        this._valueSchema = valueSchema;
    }
    _validate(input, ctx) {
        if (typeof input !== "object" || input === null || Array.isArray(input)) {
            ctx.issues.push({
                code: ISSUE_CODES.INVALID_TYPE,
                message: `Expected record, received ${describeType(input)}`,
                path: [...ctx.path],
                expected: "record",
                received: describeType(input),
            });
            return undefined;
        }
        const obj = input;
        const result = Object.create(null);
        for (const [key, value] of Object.entries(obj)) {
            ctx.path.push(key);
            Object.defineProperty(result, key, {
                value: this._valueSchema._runPipeline(value, ctx),
                writable: true,
                enumerable: true,
                configurable: true,
            });
            ctx.path.pop();
        }
        Object.setPrototypeOf(result, Object.prototype);
        return result;
    }
    _toNode() {
        const node = {
            kind: "record",
            valueSchema: this._valueSchema._toNode(),
        };
        this._addDefault(node);
        return node;
    }
}
//# sourceMappingURL=record.js.map