import { BaseSchema } from "./base.js";
import { ISSUE_CODES } from "../issue-codes.js";
import { describeType } from "../util.js";
export class BoolSchema extends BaseSchema {
    _getCoercionTarget() {
        return "bool";
    }
    _validate(input, ctx) {
        if (typeof input !== "boolean") {
            ctx.issues.push({
                code: ISSUE_CODES.INVALID_TYPE,
                message: `Expected boolean, received ${describeType(input)}`,
                path: [...ctx.path],
                expected: "bool",
                received: describeType(input),
            });
            return undefined;
        }
        return input;
    }
    _toNode() {
        const node = { kind: "bool" };
        this._addDefault(node);
        return node;
    }
}
//# sourceMappingURL=bool.js.map