export class ValidationError extends Error {
    issues;
    constructor(issues) {
        const message = issues
            .map((i) => `[${i.code}] ${i.path.length > 0 ? i.path.join(".") + ": " : ""}${i.message}`)
            .join("\n");
        super(message);
        this.name = "ValidationError";
        this.issues = issues;
    }
}
//# sourceMappingURL=errors.js.map