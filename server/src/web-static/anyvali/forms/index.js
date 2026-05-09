import { exportSchema } from "../interchange/exporter.js";
import { BaseSchema } from "../schemas/base.js";
import { importSchema } from "../interchange/importer.js";
export function createFormBindings(options) {
    const doc = normalizeSchemaSource(options.schema);
    const errorIdPrefix = options.errorIdPrefix ?? "anyvali";
    return {
        field(path, attrs = {}) {
            return {
                ...getFieldAttributes(doc, path, errorIdPrefix),
                ...attrs,
            };
        },
        errorSlot(path, attrs = {}) {
            return {
                id: errorIdForPath(path, errorIdPrefix),
                "data-anyvali-error-for": canonicalizePath(path),
                "aria-live": "polite",
                ...attrs,
            };
        },
        htmx(config) {
            const attrs = {};
            for (const [method, attr] of [
                ["get", "hx-get"],
                ["post", "hx-post"],
                ["put", "hx-put"],
                ["patch", "hx-patch"],
                ["delete", "hx-delete"],
            ]) {
                const value = config[method];
                if (value) {
                    attrs[attr] = value;
                }
            }
            if (config.target)
                attrs["hx-target"] = config.target;
            if (config.swap)
                attrs["hx-swap"] = config.swap;
            if (config.trigger)
                attrs["hx-trigger"] = config.trigger;
            if (config.select)
                attrs["hx-select"] = config.select;
            if (config.confirm)
                attrs["hx-confirm"] = config.confirm;
            if (config.include)
                attrs["hx-include"] = config.include;
            if (config.encoding)
                attrs["hx-encoding"] = config.encoding;
            if (config.ext)
                attrs["hx-ext"] = config.ext;
            if (config.indicator)
                attrs["hx-indicator"] = config.indicator;
            if (config.pushUrl)
                attrs["hx-push-url"] = config.pushUrl;
            if (config.replaceUrl)
                attrs["hx-replace-url"] = config.replaceUrl;
            if (config.validate !== undefined) {
                attrs["hx-validate"] = String(config.validate);
            }
            return attrs;
        },
        init(target, initOptions = {}) {
            return initForm(target, {
                schema: doc,
                ...initOptions,
            });
        },
    };
}
export function initForm(target, options) {
    const form = resolveForm(target);
    const doc = normalizeSchemaSource(options.schema);
    const schema = importSchema(doc);
    const validateOn = new Set(options.validateOn ?? ["blur", "submit"]);
    const nativeValidation = options.nativeValidation ?? true;
    const reportValidity = options.reportValidity ?? true;
    const useHtmx = options.htmx ?? true;
    if (nativeValidation) {
        applyNativeConstraints(form, doc);
    }
    const listeners = [];
    const addListener = (eventTarget, event, handler, options) => {
        eventTarget.addEventListener(event, handler, options);
        listeners.push({ target: eventTarget, event, handler, options });
    };
    const validateField = (fieldName, shouldReport = false) => {
        clearFieldState(form, fieldName);
        const result = schema.safeParse(readFormValues(form, doc));
        if (!result.success) {
            const fieldPath = parseFieldPath(fieldName);
            const issue = firstIssueForField(result.issues, fieldPath);
            if (issue) {
                applyFieldIssue(form, fieldName, issue);
                if (shouldReport) {
                    firstControlForField(form, fieldName)?.reportValidity?.();
                }
                return false;
            }
        }
        if (shouldReport) {
            firstControlForField(form, fieldName)?.reportValidity?.();
        }
        return true;
    };
    const validateFormState = (shouldReport = false) => {
        clearAllFieldState(form);
        const result = schema.safeParse(readFormValues(form, doc));
        if (!result.success) {
            const fieldNames = fieldNamesForForm(form);
            for (const fieldName of fieldNames) {
                const issue = firstIssueForField(result.issues, parseFieldPath(fieldName));
                if (issue) {
                    applyFieldIssue(form, fieldName, issue);
                }
            }
            if (shouldReport) {
                form.reportValidity?.();
            }
            return false;
        }
        return true;
    };
    if (validateOn.has("input")) {
        addListener(form, "input", (event) => {
            const control = event.target;
            if (control?.name) {
                validateField(control.name, false);
            }
        });
    }
    if (validateOn.has("change")) {
        addListener(form, "change", (event) => {
            const control = event.target;
            if (control?.name) {
                validateField(control.name, false);
            }
        });
    }
    if (validateOn.has("blur")) {
        addListener(form, "blur", (event) => {
            const control = event.target;
            if (control?.name) {
                validateField(control.name, reportValidity);
            }
        }, true);
    }
    addListener(form, "submit", (event) => {
        if (!validateFormState(validateOn.has("submit") && reportValidity)) {
            event.preventDefault();
            event.stopPropagation();
        }
    });
    if (useHtmx) {
        const htmx = globalThis.htmx;
        if (htmx?.config && reportValidity) {
            htmx.config.reportValidityOfForms = true;
        }
        addListener(form, "htmx:validation:validate", () => {
            validateFormState(false);
        });
    }
    return {
        form,
        document: doc,
        validate() {
            return validateFormState(false);
        },
        getValues() {
            return readFormValues(form, doc);
        },
        getResult() {
            return schema.safeParse(readFormValues(form, doc));
        },
        destroy() {
            for (const entry of listeners) {
                entry.target.removeEventListener(entry.event, entry.handler, entry.options);
            }
        },
    };
}
export function getFieldAttributes(schema, path, errorIdPrefix = "anyvali") {
    const doc = normalizeSchemaSource(schema);
    const resolved = resolveFieldSchema(doc, path);
    const attrs = {
        name: path,
        "data-anyvali-path": canonicalizePath(path),
        "aria-describedby": errorIdForPath(path, errorIdPrefix),
    };
    if (!resolved) {
        return attrs;
    }
    const { node } = resolved;
    const unwrapped = unwrapNode(resolveRefNode(doc, node));
    const effective = unwrapped.node;
    if (resolved.required && effective.kind !== "bool") {
        attrs.required = true;
    }
    if (effective.kind === "string") {
        applyStringAttributes(attrs, effective);
    }
    else if (isNumericNode(effective)) {
        applyNumericAttributes(attrs, effective);
    }
    else if (effective.kind === "bool") {
        attrs.type = "checkbox";
    }
    else if (effective.kind === "array") {
        applyArrayAttributes(attrs, effective, resolved.required);
    }
    return attrs;
}
function normalizeSchemaSource(schema) {
    if (schema instanceof BaseSchema) {
        return exportSchema(schema);
    }
    return schema;
}
function resolveForm(target) {
    if (typeof target !== "string") {
        return target;
    }
    const element = document.querySelector(target);
    if (!(element instanceof HTMLFormElement)) {
        throw new Error(`Form not found for selector: ${target}`);
    }
    return element;
}
function applyNativeConstraints(form, doc) {
    for (const fieldName of fieldNamesForForm(form)) {
        const attrs = getFieldAttributes(doc, fieldName);
        const controls = controlsForField(form, fieldName);
        for (const control of controls) {
            for (const [key, value] of Object.entries(attrs)) {
                if (key === "name" || key === "data-anyvali-path" || key === "aria-describedby") {
                    setControlAttribute(control, key, value);
                    continue;
                }
                if (value === undefined || value === null) {
                    continue;
                }
                if (key === "type" && control instanceof HTMLInputElement) {
                    if (!control.hasAttribute("type") || control.type === "text") {
                        control.type = String(value);
                    }
                    continue;
                }
                if (key === "required") {
                    if (!control.hasAttribute("required")) {
                        control.required = Boolean(value);
                    }
                    continue;
                }
                if (!control.hasAttribute(key)) {
                    setControlAttribute(control, key, value);
                }
            }
        }
    }
}
function setControlAttribute(control, key, value) {
    if (typeof value === "boolean") {
        if (value) {
            control.setAttribute(key, "");
        }
        else {
            control.removeAttribute(key);
        }
        return;
    }
    control.setAttribute(key, String(value));
}
function readFormValues(form, doc) {
    const root = {};
    for (const fieldName of fieldNamesForForm(form)) {
        const controls = controlsForField(form, fieldName);
        if (controls.length === 0)
            continue;
        const resolved = resolveFieldSchema(doc, fieldName);
        const value = readFieldValue(controls, resolved?.node);
        if (value === undefined)
            continue;
        setPathValue(root, parseFieldPath(fieldName), value);
    }
    return root;
}
function readFieldValue(controls, node) {
    const first = controls[0];
    if (!first)
        return undefined;
    const effectiveNode = node ? unwrapNode(node).node : undefined;
    if (first instanceof HTMLSelectElement && first.multiple) {
        return Array.from(first.selectedOptions).map((option) => option.value);
    }
    if (first instanceof HTMLInputElement && first.type === "radio") {
        const checked = controls.find((control) => control instanceof HTMLInputElement && control.checked);
        return checked?.value;
    }
    if (controls.every((control) => control instanceof HTMLInputElement && control.type === "checkbox")) {
        if (effectiveNode?.kind === "array") {
            return controls
                .filter((control) => control instanceof HTMLInputElement && control.checked)
                .map((control) => control.value);
        }
        const checkbox = first;
        return checkbox.checked;
    }
    if (first instanceof HTMLInputElement && isNumericLikeControl(first, effectiveNode)) {
        if (first.value === "")
            return undefined;
        return first.valueAsNumber;
    }
    const raw = first.value;
    return raw === "" ? undefined : raw;
}
function isNumericLikeControl(control, node) {
    if (!node)
        return control.type === "number";
    const effectiveNode = unwrapNode(node).node;
    return control.type === "number" || isNumericNode(effectiveNode);
}
function validateIssueMessage(issue) {
    return issue.message || "Invalid value";
}
function applyFieldIssue(form, fieldName, issue) {
    const message = validateIssueMessage(issue);
    for (const control of controlsForField(form, fieldName)) {
        control.setCustomValidity(message);
        control.setAttribute("aria-invalid", "true");
        control.setAttribute("data-anyvali-invalid", "true");
    }
    for (const slot of errorSlotsForField(form, fieldName)) {
        slot.textContent = message;
        slot.removeAttribute("hidden");
    }
}
function clearFieldState(form, fieldName) {
    for (const control of controlsForField(form, fieldName)) {
        control.setCustomValidity("");
        control.removeAttribute("aria-invalid");
        control.removeAttribute("data-anyvali-invalid");
    }
    for (const slot of errorSlotsForField(form, fieldName)) {
        slot.textContent = "";
        slot.setAttribute("hidden", "");
    }
}
function clearAllFieldState(form) {
    for (const fieldName of fieldNamesForForm(form)) {
        clearFieldState(form, fieldName);
    }
}
function controlsForField(form, fieldName) {
    return Array.from(form.querySelectorAll(`[name="${cssEscape(fieldName)}"]`));
}
function firstControlForField(form, fieldName) {
    return controlsForField(form, fieldName)[0];
}
function errorSlotsForField(form, fieldName) {
    const canonical = canonicalizePath(fieldName);
    return Array.from(form.querySelectorAll(`[data-anyvali-error-for="${cssEscape(canonical)}"]`));
}
function fieldNamesForForm(form) {
    return Array.from(new Set(Array.from(form.elements)
        .filter((element) => {
        return (element instanceof HTMLInputElement ||
            element instanceof HTMLSelectElement ||
            element instanceof HTMLTextAreaElement);
    })
        .map((element) => element.name)
        .filter(Boolean)));
}
function resolveFieldSchema(doc, path) {
    const segments = parseFieldPath(path);
    let current = doc.root;
    let required = true;
    let nullable = false;
    for (const segment of segments) {
        if (!current) {
            return null;
        }
        const unwrapped = unwrapNode(resolveRefNode(doc, current));
        current = unwrapped.node;
        nullable = nullable || unwrapped.nullable;
        if (current.kind === "object" && typeof segment === "string") {
            const objectNode = current;
            const propertyNode = objectNode.properties[segment];
            if (!propertyNode) {
                return null;
            }
            const propertyUnwrapped = unwrapNode(resolveRefNode(doc, propertyNode));
            required = required && objectNode.required.includes(segment) && !propertyUnwrapped.optional;
            nullable = nullable || propertyUnwrapped.nullable;
            current = propertyUnwrapped.node;
            continue;
        }
        if (current.kind === "record" && typeof segment === "string") {
            current = resolveRefNode(doc, current.valueSchema);
            continue;
        }
        if (current.kind === "array") {
            current = resolveRefNode(doc, current.items);
            continue;
        }
        return null;
    }
    if (!current) {
        return null;
    }
    const unwrapped = unwrapNode(resolveRefNode(doc, current));
    return {
        path: segments,
        canonicalName: formatPath(segments),
        required: required && !unwrapped.optional,
        nullable: nullable || unwrapped.nullable,
        node: unwrapped.node,
    };
}
function resolveRefNode(doc, node) {
    let current = node;
    const seen = new Set();
    while (current.kind === "ref") {
        const name = current.ref.replace(/^#\/definitions\//, "");
        if (seen.has(name)) {
            break;
        }
        seen.add(name);
        const resolved = doc.definitions[name];
        if (!resolved) {
            break;
        }
        current = resolved;
    }
    return current;
}
function unwrapNode(node) {
    let current = node;
    let optional = false;
    let nullable = false;
    while (current.kind === "optional" || current.kind === "nullable") {
        if (current.kind === "optional") {
            optional = true;
            current = current.inner;
        }
        else {
            nullable = true;
            current = current.inner;
        }
    }
    return { node: current, optional, nullable };
}
function applyStringAttributes(attrs, node) {
    if (attrs.type === undefined) {
        const type = htmlTypeForStringFormat(node.format);
        if (type) {
            attrs.type = type;
        }
    }
    if (node.minLength !== undefined)
        attrs.minLength = node.minLength;
    if (node.maxLength !== undefined)
        attrs.maxLength = node.maxLength;
    if (node.pattern !== undefined)
        attrs.pattern = node.pattern;
}
function applyNumericAttributes(attrs, node) {
    if (attrs.type === undefined)
        attrs.type = "number";
    if (node.min !== undefined)
        attrs.min = node.min;
    if (node.max !== undefined)
        attrs.max = node.max;
    if (node.multipleOf !== undefined) {
        attrs.step = node.multipleOf;
    }
    else if (isIntegerKind(node.kind)) {
        attrs.step = 1;
    }
    attrs.inputMode = isIntegerKind(node.kind) ? "numeric" : "decimal";
}
function applyArrayAttributes(attrs, node, required) {
    if (required || (node.minItems ?? 0) > 0) {
        attrs.required = true;
    }
}
function htmlTypeForStringFormat(format) {
    switch (format) {
        case "email":
            return "email";
        case "url":
            return "url";
        case "date":
            return "date";
        case "date-time":
            return "datetime-local";
        default:
            return undefined;
    }
}
function firstIssueForField(issues, fieldPath) {
    return issues.find((issue) => isIssueForField(issue, fieldPath));
}
function isIssueForField(issue, fieldPath) {
    if (issue.path.length < fieldPath.length) {
        return false;
    }
    return fieldPath.every((segment, index) => issue.path[index] === segment);
}
function parseFieldPath(path) {
    const segments = [];
    const matcher = /([^[.\]]+)|\[(.*?)\]/g;
    for (const match of path.matchAll(matcher)) {
        const token = match[1] ?? match[2];
        if (!token)
            continue;
        if (/^\d+$/.test(token)) {
            segments.push(Number(token));
        }
        else {
            segments.push(token);
        }
    }
    return segments;
}
function canonicalizePath(path) {
    return formatPath(parseFieldPath(path));
}
function formatPath(path) {
    return path
        .map((segment, index) => {
        if (typeof segment === "number") {
            return `[${segment}]`;
        }
        return index === 0 ? segment : `.${segment}`;
    })
        .join("");
}
function setPathValue(root, path, value) {
    if (path.length === 0)
        return;
    let current = root;
    for (let index = 0; index < path.length; index++) {
        const segment = path[index];
        const isLast = index === path.length - 1;
        const key = String(segment);
        if (isLast) {
            current[key] = value;
            return;
        }
        const existing = current[key];
        if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
            current[key] = {};
        }
        current = current[key];
    }
}
function errorIdForPath(path, prefix) {
    return `${prefix}-error-${canonicalizePath(path).replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
}
function cssEscape(value) {
    const cssApi = globalThis.CSS;
    if (cssApi?.escape) {
        return cssApi.escape(value);
    }
    return value.replace(/["\\]/g, "\\$&");
}
function isNumericNode(node) {
    return [
        "number",
        "int",
        "float32",
        "float64",
        "int8",
        "int16",
        "int32",
        "int64",
        "uint8",
        "uint16",
        "uint32",
        "uint64",
    ].includes(node.kind);
}
function isIntegerKind(kind) {
    return kind.startsWith("int") || kind.startsWith("uint");
}
//# sourceMappingURL=index.js.map