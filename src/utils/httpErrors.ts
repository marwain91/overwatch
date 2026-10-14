/**
 * Typed HTTP errors. Services throw these where a caller mistake or a missing
 * resource is meant; the REST error handler and the MCP tool wrappers map them
 * once instead of every route string-matching messages.
 *
 * `expose` decides whether the message may reach the client. 4xx errors are
 * exposed by default; 5xx are not unless the thrower opts in (the message is
 * known to be safe and useful, e.g. a compose failure summary).
 */
export class HttpError extends Error {
  readonly status: number;
  readonly expose: boolean;
  /** What a client may see when `expose` is set; defaults to `message`. Lets an error keep a detailed message for logs. */
  readonly clientMessage: string;

  constructor(status: number, message: string, options: { expose?: boolean; clientMessage?: string } = {}) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.expose = options.expose ?? status < 500;
    this.clientMessage = options.clientMessage ?? message;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends HttpError {
  constructor(message: string) {
    super(400, message);
  }
}

export class NotFoundError extends HttpError {
  constructor(message: string) {
    super(404, message);
  }
}

export class ConflictError extends HttpError {
  constructor(message: string) {
    super(409, message);
  }
}
