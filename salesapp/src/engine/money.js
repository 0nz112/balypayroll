// Money helpers — IQD has no minor unit in practice; everything is an integer.
export function toIQD(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('VALIDATION');
    return value;
  }
  const clean = String(value ?? '').replace(/[٬,\s]/g, '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
  if (!/^-?\d{1,15}$/.test(clean)) throw new Error('VALIDATION');
  return Number(clean);
}

export function formatIQD(n, lang = 'ar', { withUnit = true, digits = 'latn' } = {}) {
  const v = Number(n ?? 0);
  const locale = lang === 'ar' ? `ar-IQ-u-nu-${digits}` : 'en-US';
  const s = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(v);
  if (!withUnit) return s;
  return lang === 'ar' ? `${s} د.ع` : `${s} IQD`;
}

export function formatNumber(n, lang = 'ar', digits = 'latn') {
  return new Intl.NumberFormat(lang === 'ar' ? `ar-IQ-u-nu-${digits}` : 'en-US', { maximumFractionDigits: 0 }).format(Number(n ?? 0));
}
