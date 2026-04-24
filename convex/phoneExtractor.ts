const PHONE_REGEX = /(?:\+?(?:375|380|7)|8)[\s\-\(\)\.]?\d{2,3}[\s\-\(\)\.]?\d{3}[\s\-\.]?\d{2}[\s\-\.]?\d{2}/g;

export interface ExtractedPhone {
  phone: string;   // normalized: "+375291234567"
  raw: string;     // as found in text
}

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  // BY mobile codes: 029, 033, 044, 025, 017
  const BY_CODES = ["029", "033", "044", "025", "017"];
  if (digits.startsWith("80") && digits.length === 11) {
    const code = digits.slice(1, 4);  // e.g. "029"
    if (BY_CODES.includes(code)) {
      return "+375" + digits.slice(2);
    }
    // Not a BY code — treat as RU (8 → +7)
    return "+7" + digits.slice(1);
  }
  if (digits.startsWith("8") && digits.length === 11) {
    return "+7" + digits.slice(1);
  }
  if (digits.startsWith("375") || digits.startsWith("380") || digits.startsWith("7")) {
    return "+" + digits;
  }
  return "+" + digits;
}

export function extractPhones(text: string): ExtractedPhone[] {
  if (!text) return [];
  const matches = text.match(PHONE_REGEX);
  if (!matches) return [];
  const seen = new Set<string>();
  const result: ExtractedPhone[] = [];
  for (const m of matches) {
    const normalized = normalizePhone(m);
    // Sanity check — must be at least 11 digits after +
    if (normalized.replace(/\D/g, "").length < 10) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push({ phone: normalized, raw: m });
  }
  return result;
}
