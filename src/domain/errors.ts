export type ErrorKind = 'validation' | 'not_found' | 'conflict' | 'retryable' | 'human_required' | 'terminal';

export class OrviaError extends Error {
  constructor(
    message: string,
    readonly kind: ErrorKind,
    readonly statusCode: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'OrviaError';
  }
}

export const validationError = (message: string, details?: unknown) =>
  new OrviaError(message, 'validation', 400, details);

export const notFoundError = (message: string) =>
  new OrviaError(message, 'not_found', 404);

export const conflictError = (message: string, details?: unknown) =>
  new OrviaError(message, 'conflict', 409, details);
