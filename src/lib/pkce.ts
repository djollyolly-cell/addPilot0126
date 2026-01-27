// PKCE (Proof Key for Code Exchange) utilities for VK ID OAuth 2.1

function generateRandomString(length: number): string {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(36).padStart(2, '0'))
    .join('')
    .slice(0, length);
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateCodeVerifier(): string {
  return generateRandomString(64);
}

export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(digest);
}

export function generateState(): string {
  return generateRandomString(32);
}

const STORAGE_KEY_VERIFIER = 'vkid_code_verifier';
const STORAGE_KEY_STATE = 'vkid_state';

export function storePkceParams(codeVerifier: string, state: string): void {
  sessionStorage.setItem(STORAGE_KEY_VERIFIER, codeVerifier);
  sessionStorage.setItem(STORAGE_KEY_STATE, state);
}

export function getPkceParams(): { codeVerifier: string | null; state: string | null } {
  return {
    codeVerifier: sessionStorage.getItem(STORAGE_KEY_VERIFIER),
    state: sessionStorage.getItem(STORAGE_KEY_STATE),
  };
}

export function clearPkceParams(): void {
  sessionStorage.removeItem(STORAGE_KEY_VERIFIER);
  sessionStorage.removeItem(STORAGE_KEY_STATE);
}
