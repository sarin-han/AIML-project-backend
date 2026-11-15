/**
 * 임의의 고유 ID. `crypto.randomUUID`는 HTTPS(또는 localhost)에서만 있어서,
 * HTTP로 열었을 때는 `crypto.getRandomValues`, 그것도 없으면 `Math.random`으로 대신한다.
 */
export function createId(): string {
  const webCrypto = typeof crypto !== 'undefined' ? crypto : undefined;
  if (webCrypto && typeof webCrypto.randomUUID === 'function') return webCrypto.randomUUID();

  const bytes = new Uint8Array(16);
  if (webCrypto && typeof webCrypto.getRandomValues === 'function') webCrypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);

  bytes[6] = (bytes[6] & 0x0f) | 0x40; // UUID v4
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
