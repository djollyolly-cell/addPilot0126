import { describe, test, expect } from "vitest";
import { extractPhones, normalizePhone } from "./phoneExtractor";

describe("normalizePhone", () => {
  test("8 (XXX) XXX-XX-XX → +7XXXXXXXXXX", () => {
    expect(normalizePhone("8 (900) 123-45-67")).toBe("+79001234567");
  });
  test("+375 29 123 45 67 → +375291234567", () => {
    expect(normalizePhone("+375 29 123 45 67")).toBe("+375291234567");
  });
  test("380501234567 → +380501234567", () => {
    expect(normalizePhone("380501234567")).toBe("+380501234567");
  });
});

describe("extractPhones", () => {
  test("extracts single phone", () => {
    const r = extractPhones("+375 29 123-45-67");
    expect(r.map((p) => p.phone)).toEqual(["+375291234567"]);
  });
  test("extracts multiple phones", () => {
    const r = extractPhones("+7 900 111 22 33 или 8(495)555-66-77");
    expect(r.map((p) => p.phone).sort()).toEqual(
      ["+74955556677", "+79001112233"].sort()
    );
  });
  test("handles sloppy formatting", () => {
    const r = extractPhones("тел: 80291234567");
    expect(r.map((p) => p.phone)).toEqual(["+375291234567"]);
  });
  test("89991234567 is RU not BY", () => {
    const r = extractPhones("тел: 89991234567");
    expect(r.map((p) => p.phone)).toEqual(["+79991234567"]);
  });
  test("returns empty for text without phones", () => {
    expect(extractPhones("просто текст без цифр")).toEqual([]);
  });
});
