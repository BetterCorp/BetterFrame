import { NumberSchema } from "./number.js";
import { ISSUE_CODES } from "../issue-codes.js";
import { describeType } from "../util.js";
const INT_RANGES = {
    int8: { min: -128, max: 127 },
    int16: { min: -32768, max: 32767 },
    int32: { min: -2147483648, max: 2147483647 },
    int64: { min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER },
    uint8: { min: 0, max: 255 },
    uint16: { min: 0, max: 65535 },
    uint32: { min: 0, max: 4294967295 },
    uint64: { min: 0, max: Number.MAX_SAFE_INTEGER },
    int: { min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER },
};
export class IntSchema extends NumberSchema {
    _intRange;
    constructor(kind = "int") {
        super(kind);
        this._intRange = INT_RANGES[kind] ?? INT_RANGES.int;
    }
    _validate(input, ctx) {
        if (typeof input !== "number" || !Number.isFinite(input)) {
            ctx.issues.push({
                code: ISSUE_CODES.INVALID_TYPE,
                message: `Expected integer, received ${describeType(input)}`,
                path: [...ctx.path],
                expected: this._kind,
                received: describeType(input),
            });
            return undefined;
        }
        if (!Number.isInteger(input)) {
            ctx.issues.push({
                code: ISSUE_CODES.INVALID_TYPE,
                message: `Expected integer, received float`,
                path: [...ctx.path],
                expected: this._kind,
                received: "number",
            });
            return undefined;
        }
        // Range check for the specific int width
        if (input > this._intRange.max) {
            ctx.issues.push({
                code: ISSUE_CODES.TOO_LARGE,
                message: `Value ${input} is above the maximum for ${this._kind}`,
                path: [...ctx.path],
                expected: this._kind,
                received: String(input),
            });
            return undefined;
        }
        if (input < this._intRange.min) {
            ctx.issues.push({
                code: ISSUE_CODES.TOO_SMALL,
                message: `Value ${input} is below the minimum for ${this._kind}`,
                path: [...ctx.path],
                expected: this._kind,
                received: String(input),
            });
            return undefined;
        }
        // Additional user constraints
        this._validateConstraints(input, ctx);
        return input;
    }
}
export class Int8Schema extends IntSchema {
    constructor() {
        super("int8");
    }
}
export class Int16Schema extends IntSchema {
    constructor() {
        super("int16");
    }
}
export class Int32Schema extends IntSchema {
    constructor() {
        super("int32");
    }
}
export class Int64Schema extends IntSchema {
    constructor() {
        super("int64");
    }
}
export class Uint8Schema extends IntSchema {
    constructor() {
        super("uint8");
    }
}
export class Uint16Schema extends IntSchema {
    constructor() {
        super("uint16");
    }
}
export class Uint32Schema extends IntSchema {
    constructor() {
        super("uint32");
    }
}
export class Uint64Schema extends IntSchema {
    constructor() {
        super("uint64");
    }
}
//# sourceMappingURL=int.js.map