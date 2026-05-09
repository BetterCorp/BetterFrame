import { BaseSchema } from "./base.js";
import { ISSUE_CODES } from "../issue-codes.js";
import { describeType } from "../util.js";
export class UnionSchema extends BaseSchema {
    _variants;
    constructor(variants) {
        super();
        this._variants = variants;
    }
    _validate(input, ctx) {
        for (const variant of this._variants) {
            const innerCtx = {
                path: [...ctx.path],
                issues: [],
            };
            const result = variant._runPipeline(input, innerCtx);
            if (innerCtx.issues.length === 0) {
                return result;
            }
        }
        const variantKinds = this._variants.map((v) => v._toNode().kind);
        ctx.issues.push({
            code: ISSUE_CODES.INVALID_UNION,
            message: `Input did not match any variant of the union`,
            path: [...ctx.path],
            expected: variantKinds.join(" | "),
            received: describeType(input),
        });
        return undefined;
    }
    _toNode() {
        const node = {
            kind: "union",
            variants: this._variants.map((v) => v._toNode()),
        };
        this._addDefault(node);
        return node;
    }
}
//# sourceMappingURL=union.js.map