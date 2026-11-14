import { describe, expect, it } from "vitest";
import { fromKop, parseRub, toKop } from "../src/utils/money.js";

describe("parseRub", () => {
  it("принимает число и строку с числом", () => {
    expect(parseRub(2500)).toBe(2500);
    expect(parseRub("2500.00")).toBe(2500);
    expect(parseRub(" 99 ")).toBe(99);
  });

  it("отклоняет некорректные, пустые, отрицательные и не конечные суммы", () => {
    for (const raw of ["abc", "", "   ", "0x10", "NaN", "Infinity", null, -1, NaN, Infinity]) {
      expect(() => parseRub(raw)).toThrow();
    }
  });

  it("отклоняет значения с ненулевой долей копейки", () => {
    expect(() => parseRub(10.999)).toThrow();
  });
});

describe("toKop / fromKop", () => {
  it("точно преобразует number и decimal strings в копейки", () => {
    expect(toKop(1.15)).toBe(115);
    expect(toKop(0.29)).toBe(29);
    expect(toKop(10.01)).toBe(1001);
    expect(toKop(99.99)).toBe(9999);
    expect(toKop(2500)).toBe(250000);
    expect(toKop("2500.10")).toBe(250010);
    expect(toKop("0.01")).toBe(1);
  });

  it("принимает нулевые лишние десятичные знаки, но отклоняет дробную копейку", () => {
    expect(toKop("10.990")).toBe(1099);
    expect(() => toKop(10.999)).toThrow();
    expect(() => toKop("10.999")).toThrow();
  });

  it("поддерживает экспоненциальную запись и проверяет переполнение", () => {
    expect(toKop("1e2")).toBe(10000);
    expect(toKop("1e-2")).toBe(1);
    expect(toKop("90071992547409.91")).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => toKop("1e-3")).toThrow();
    expect(() => toKop("1e100")).toThrow();
    expect(() => toKop(Number.MAX_VALUE)).toThrow();
    expect(() => toKop("90071992547409.92")).toThrow();
  });

  it("отклоняет неверные формы и нечисловые значения", () => {
    for (const raw of ["", "  ", "0x10", "-1", "NaN", "Infinity", -1, NaN, Infinity]) {
      expect(() => toKop(raw)).toThrow();
    }
  });

  it("копейки в рубли", () => {
    expect(fromKop(250000)).toBe(2500);
    expect(fromKop(1099)).toBe(10.99);
  });
});
