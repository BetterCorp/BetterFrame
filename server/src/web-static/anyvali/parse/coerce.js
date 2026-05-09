/**
 * Normalize coercion config from the corpus/interchange format.
 * The corpus uses strings like "string->int", "trim", "lower", "upper"
 * or arrays like ["trim", "lower"]. The SDK API uses CoercionConfig objects.
 */
export function normalizeCoercionConfig(raw) {
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
        return raw;
    }
    const config = {};
    const items = Array.isArray(raw) ? raw : [raw];
    for (const item of items) {
        switch (item) {
            case "string->int":
            case "string->number":
            case "string->bool":
                config.from = "string";
                break;
            case "trim":
                config.trim = true;
                break;
            case "lower":
                config.lower = true;
                break;
            case "upper":
                config.upper = true;
                break;
        }
    }
    return config;
}
export function applyCoercion(input, config, targetType) {
    let value = input;
    // String transformations (trim, lower, upper) apply when input is a string
    if (typeof value === "string") {
        if (config.trim) {
            value = value.trim();
        }
        if (config.lower) {
            value = value.toLowerCase();
        }
        if (config.upper) {
            value = value.toUpperCase();
        }
    }
    // Type coercion from string to target
    if (config.from === "string" && typeof value === "string") {
        switch (targetType) {
            case "int":
            case "int8":
            case "int16":
            case "int32":
            case "int64":
            case "uint8":
            case "uint16":
            case "uint32":
            case "uint64": {
                const trimmed = value.trim();
                if (trimmed === "" || !/^-?\d+$/.test(trimmed)) {
                    return {
                        success: false,
                        message: `Cannot coerce "${value}" to ${targetType}`,
                    };
                }
                const num = Number(trimmed);
                if (!Number.isFinite(num) || !Number.isInteger(num)) {
                    return {
                        success: false,
                        message: `Cannot coerce "${value}" to ${targetType}`,
                    };
                }
                value = num;
                break;
            }
            case "number":
            case "float32":
            case "float64": {
                const trimmed = value.trim();
                if (trimmed === "") {
                    return {
                        success: false,
                        message: `Cannot coerce empty string to ${targetType}`,
                    };
                }
                const num = Number(trimmed);
                if (!Number.isFinite(num)) {
                    return {
                        success: false,
                        message: `Cannot coerce "${value}" to ${targetType}`,
                    };
                }
                value = num;
                break;
            }
            case "bool": {
                const lower = value.trim().toLowerCase();
                if (lower === "true" || lower === "1") {
                    value = true;
                }
                else if (lower === "false" || lower === "0") {
                    value = false;
                }
                else {
                    return {
                        success: false,
                        message: `Cannot coerce "${value}" to bool`,
                    };
                }
                break;
            }
        }
    }
    return { success: true, value };
}
//# sourceMappingURL=coerce.js.map