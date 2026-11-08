type Fields = Record<string, unknown>;

function scrub(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, 'Bearer REDACTED')
    .replace(/q-ak=[^&\s]+/gi, 'q-ak=REDACTED')
    .replace(/Secret(Id|Key)\s*[:=]\s*\S+/gi, 'Secret$1=REDACTED')
    .replace(/[A-Za-z0-9+/]{80,}={0,2}/g, '[redacted-blob]')
    .slice(0, 400);
}

function write(level: 'info' | 'warn' | 'error', message: string, fields?: Fields): void {
  const line = {
    time: new Date().toISOString(),
    level,
    message: scrub(message),
    ...fields,
  };
  const text = JSON.stringify(line);
  if (level === 'error') console.error(text);
  else if (level === 'warn') console.warn(text);
  else console.log(text);
}

export const log = {
  info(message: string, fields?: Fields): void {
    write('info', message, fields);
  },
  warn(message: string, fields?: Fields): void {
    write('warn', message, fields);
  },
  error(message: string, fields?: Fields): void {
    write('error', message, fields);
  },
};
