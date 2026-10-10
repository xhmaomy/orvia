export class OrviaError extends Error {
    kind;
    statusCode;
    details;
    constructor(message, kind, statusCode, details) {
        super(message);
        this.kind = kind;
        this.statusCode = statusCode;
        this.details = details;
        this.name = 'OrviaError';
    }
}
export const validationError = (message, details) => new OrviaError(message, 'validation', 400, details);
export const notFoundError = (message) => new OrviaError(message, 'not_found', 404);
export const conflictError = (message, details) => new OrviaError(message, 'conflict', 409, details);
