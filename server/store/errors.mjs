export class StoreError extends Error {
  constructor(message, { code = "STORE_ERROR", cause } = {}) {
    super(message, { cause });
    this.name = this.constructor.name;
    this.code = code;
  }
}

export class ValidationError extends StoreError {
  constructor(message, options = {}) {
    super(message, { ...options, code: "VALIDATION_ERROR" });
  }
}

export class NotFoundError extends StoreError {
  constructor(message, options = {}) {
    super(message, { ...options, code: "NOT_FOUND" });
  }
}

export class ConflictError extends StoreError {
  constructor(message, options = {}) {
    super(message, { ...options, code: "REVISION_CONFLICT" });
  }
}

export class PreviewExpiredError extends StoreError {
  constructor(message, options = {}) {
    super(message, { ...options, code: "PREVIEW_EXPIRED" });
  }
}

export class CorruptionError extends StoreError {
  constructor(message, options = {}) {
    super(message, { ...options, code: "CORRUPT_CANONICAL_STATE" });
  }
}
