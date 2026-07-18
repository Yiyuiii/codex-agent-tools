const REDACTED = "[REDACTED]";

export function redactText(text: string, secretValues: readonly string[]): string {
  let redacted = text.replace(
    /(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi,
    `$1${REDACTED}`,
  );
  redacted = redacted.replace(
    /((?:x-api-key|x-goog-api-key)\s*[:=]\s*)[^\s,;]+/gi,
    `$1${REDACTED}`,
  );

  const uniqueSecrets = [...new Set(secretValues)]
    .filter((value) => value.trim() !== "" && value !== REDACTED)
    .sort((left, right) => right.length - left.length);

  for (const secret of uniqueSecrets) {
    redacted = redacted.replaceAll(secret, REDACTED);
  }

  return redacted;
}
