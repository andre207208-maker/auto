/**
 * Input sanitization & validation helpers for Cloudflare Workers edge security.
 */

export function sanitizePlainText(input: string, maxLength = 2000): string {
  return input
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .trim()
    .slice(0, maxLength);
}

export function validateHttpsUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Invalid URL format');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('URL must use https://');
  }
  return parsed.toString();
}
