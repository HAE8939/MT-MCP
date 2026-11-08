/** An error whose message is safe to return to an MCP client. */
export class PublicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicError';
  }
}
