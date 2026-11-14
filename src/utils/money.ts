/**
 * Деньги внутри сервиса — целые копейки. Рубли — только на входе (внешний API) и в ответах.
 */

const DECIMAL_RE = /^\+?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/;
const MAX_SAFE_KOP = BigInt(Number.MAX_SAFE_INTEGER);

function parseRubKopecks(raw: unknown): bigint {
  let value: string;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < 0) {
      throw new Error(`invalid amount: ${JSON.stringify(raw)}`);
    }
    value = String(raw);
  } else if (typeof raw === "string") {
    value = raw.trim();
    if (value === "") throw new Error(`invalid amount: ${JSON.stringify(raw)}`);
  } else {
    throw new Error(`invalid amount: ${JSON.stringify(raw)}`);
  }

  const match = DECIMAL_RE.exec(value);
  if (!match) throw new Error(`invalid amount: ${JSON.stringify(raw)}`);

  const integer = match[1] ?? "0";
  const fraction = match[2] ?? match[3] ?? "";
  const exponent = Number(match[4] ?? "0");
  if (!Number.isSafeInteger(exponent)) throw new Error(`invalid amount: ${JSON.stringify(raw)}`);

  const digits = `${integer}${fraction}`.replace(/^0+/, "") || "0";
  if (digits === "0") return 0n;

  const scale = exponent - fraction.length + 2;
  let kopecks: bigint;
  if (scale >= 0) {
    if (digits.length + scale > Number.MAX_SAFE_INTEGER.toString().length) {
      throw new Error(`amount exceeds safe kopeck range: ${JSON.stringify(raw)}`);
    }
    kopecks = BigInt(digits) * 10n ** BigInt(scale);
  } else {
    const discardedDigits = -scale;
    if (discardedDigits > digits.length) {
      throw new Error(`amount has a fractional kopeck: ${JSON.stringify(raw)}`);
    }
    const fractionalKopecks = digits.slice(digits.length - discardedDigits);
    if (/[1-9]/.test(fractionalKopecks)) {
      throw new Error(`amount has a fractional kopeck: ${JSON.stringify(raw)}`);
    }
    kopecks = BigInt(digits.slice(0, digits.length - discardedDigits) || "0");
  }

  if (kopecks > MAX_SAFE_KOP) {
    throw new Error(`amount exceeds safe kopeck range: ${JSON.stringify(raw)}`);
  }
  return kopecks;
}

/** Сумма из внешнего API, возвращённая в рублях для совместимости. */
export function parseRub(raw: unknown): number {
  return Number(parseRubKopecks(raw)) / 100;
}

/** Точное преобразование рублей в копейки; исходные строки не проходят через Number. */
export function toKop(raw: unknown): number {
  return Number(parseRubKopecks(raw));
}

/** Копейки → рубли для ответа API. */
export function fromKop(kop: number): number {
  return kop / 100;
}
