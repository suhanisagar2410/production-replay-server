const SENSITIVE_FIELDS = new Set([
  'password', 'token', 'secret', 'authorization', 'cookie', 'ssn', 'credit_card', 'apikey', 'cvv'
]);

export function redactObject(obj: any): any {
  if (!obj || typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map(item => redactObject(item));
  }

  const redacted: Record<string, any> = {};
  for (const k of Object.keys(obj)) {
    if (SENSITIVE_FIELDS.has(k.toLowerCase())) {
      redacted[k] = '[REDACTED]';
    } else if (typeof obj[k] === 'object') {
      redacted[k] = redactObject(obj[k]);
    } else {
      redacted[k] = obj[k];
    }
  }

  return redacted;
}
