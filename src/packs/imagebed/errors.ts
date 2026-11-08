/** An error whose message is safe to return to an MCP client. */
export class PublicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicError';
  }
}

export function scrubClientMessage(message: string): string {
  return message
    .replace(/q-ak=[^&\s]+/gi, 'q-ak=REDACTED')
    .replace(/q-signature=[^&\s]+/gi, 'q-signature=REDACTED')
    .replace(/Authorization:\s*\S+/gi, 'Authorization: REDACTED')
    .replace(/Secret(Id|Key)\s*[:=]\s*\S+/gi, 'Secret$1=REDACTED');
}
