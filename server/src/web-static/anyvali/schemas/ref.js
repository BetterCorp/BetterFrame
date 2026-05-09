import { BaseSchema } from "./base.js";
import { ISSUE_CODES } from "../issue-codes.js";
export class RefSchema extends BaseSchema {
    _ref;
    _resolver;
    constructor(ref, resolver) {
        super();
        this._ref = ref;
        this._resolver = resolver;
    }
    _validate(input, ctx) {
        if (this._resolver) {
            const resolved = this._resolver();
            return resolved._validate(input, ctx);
        }
        ctx.issues.push({
            code: ISSUE_CODES.UNSUPPORTED_SCHEMA_KIND,
            message: `Unresolved ref: ${this._ref}`,
            path: [...ctx.path],
        });
        return undefined;
    }
    _toNode() {
        return {
            kind: "ref",
            ref: this._ref,
        };
    }
}
//# sourceMappingURL=ref.js.map