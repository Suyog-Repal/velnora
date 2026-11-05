/** Display currency. This changes the symbol and number format only: Velnora does not convert amounts between currencies. */
export interface CurrencyInfo { code: string; symbol: string; name: string; locale: string }

export const CURRENCIES: CurrencyInfo[] = [
  { code: 'INR', symbol: '₹', name: 'Indian rupee', locale: 'en-IN' },
  { code: 'USD', symbol: '$', name: 'US dollar', locale: 'en-US' },
  { code: 'EUR', symbol: '€', name: 'Euro', locale: 'de-DE' },
  { code: 'GBP', symbol: '£', name: 'British pound', locale: 'en-GB' },
  { code: 'AED', symbol: 'AED ', name: 'UAE dirham', locale: 'en-AE' },
  { code: 'SGD', symbol: 'S$', name: 'Singapore dollar', locale: 'en-SG' },
  { code: 'AUD', symbol: 'A$', name: 'Australian dollar', locale: 'en-AU' },
  { code: 'CAD', symbol: 'C$', name: 'Canadian dollar', locale: 'en-CA' },
];

let active: CurrencyInfo = CURRENCIES[0];

export function setActiveCurrency(code: string): void {
  active = CURRENCIES.find((c) => c.code === code) ?? CURRENCIES[0];
}
export const activeCurrency = (): CurrencyInfo => active;
export const currencySymbol = (): string => active.symbol.trim();

/** Formats integer minor units (paise/cents). Negative values keep their sign. */
export function formatMinor(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  return `${sign}${active.symbol}${whole.toLocaleString(active.locale)}${frac ? `.${String(frac).padStart(2, '0')}` : ''}`;
}

/** Formats a decimal amount (e.g. 12.5) the same way. */
export const formatAmount = (amount: number): string => formatMinor(Math.round(amount * 100));
