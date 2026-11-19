// Export helpers: CSV, Excel (.xlsx), PNG, PDF and native share / WhatsApp.
// PDFs are rendered from the same high-resolution image as the PNG, which
// guarantees correct Arabic shaping and RTL layout in every viewer.
// Heavy libraries are loaded on demand to keep the initial bundle small.

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const cell = (v) => (v == null ? '' : String(v));

/** columns: [{ key, label, value?: (row) => any }] */
export function toCSV(rows, columns) {
  const esc = (v) => { const s = cell(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [columns.map((c) => esc(c.label)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => esc(c.value ? c.value(r) : r[c.key])).join(','));
  return new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
}

const xml = (s) => cell(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = (i) => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

/** Single-sheet convenience wrapper. */
export function toXLSX(rows, columns, { sheetName = 'Sheet1', rtl } = {}) { return toXLSXSheets([{ name: sheetName, rows, columns }], { rtl }); }

/** Minimal, standards-compliant XLSX writer: several sheets, RTL, numeric cells stay numeric. */
export async function toXLSXSheets(sheets, { rtl = typeof document !== 'undefined' ? document.documentElement.dir === 'rtl' : true } = {}) {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const rowXml = (vals, r, header) => `<row r="${r}">${vals.map((v, i) => {
    const ref = `${colName(i)}${r}`;
    if (!header && typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}" s="1"><v>${v}</v></c>`;
    return `<c r="${ref}" t="inlineStr"${header ? ' s="2"' : ''}><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
  }).join('')}</row>`;
  const names = sheets.map((sh, i) => (String(sh.name || `Sheet${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || `Sheet${i + 1}`));
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${xml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  zip.file('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDDF6FB"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf/><xf numFmtId="164" applyNumberFormat="1"/><xf fontId="1" fillId="2" applyFont="1" applyFill="1"/></cellXfs></styleSheet>`);
  sheets.forEach(({ rows, columns }, si) => {
    const body = [rowXml(columns.map((c) => c.label), 1, true), ...rows.map((r, i) => rowXml(columns.map((c) => (c.value ? c.value(r) : r[c.key])), i + 2))].join('');
    const widths = columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 18}" customWidth="1"/>`).join('');
    zip.file(`xl/worksheets/sheet${si + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"${rtl ? ' rightToLeft="1"' : ''}><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths}</cols><sheetData>${body}</sheetData></worksheet>`);
  });
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

export async function nodeToPng(node, { pixelRatio = 2, background } = {}) {
  const { toPng } = await import('html-to-image');
  const opts = { pixelRatio, cacheBust: true, backgroundColor: background };
  let dataUrl;
  try { dataUrl = await toPng(node, opts); } catch { dataUrl = await toPng(node, { ...opts, skipFonts: true }); }
  // decode locally (fetching a data: URL is blocked by a strict Content-Security-Policy)
  const [meta, b64] = dataUrl.split(',');
  const bin = atob(b64); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: meta.slice(5).split(';')[0] || 'image/png' });
}

/** Wrap a PNG into an A4 PDF, splitting tall images across pages. */
export async function pngToPdf(pngBlob, { margin = 24 } = {}) {
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  const img = await pdf.embedPng(new Uint8Array(await pngBlob.arrayBuffer()));
  const W = 595.28, H = 841.89;
  const scale = (W - margin * 2) / img.width;
  const h = img.height * scale; const usable = H - margin * 2;
  const pages = Math.max(1, Math.ceil(h / usable - 0.0001));
  for (let i = 0; i < pages; i++) {
    const page = pdf.addPage([W, H]);
    page.drawImage(img, { x: margin, y: H - margin - h + i * usable, width: W - margin * 2, height: h });
  }
  pdf.setTitle('Report'); pdf.setCreator('Sales & Payroll');
  return new Blob([await pdf.save()], { type: 'application/pdf' });
}

/** Several page nodes (one per A4 page) → one PDF, each page drawn full-bleed. */
export async function pagesToPdf(nodes, { title = 'Report' } = {}) {
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  for (const node of nodes) {
    const png = await nodeToPng(node, { pixelRatio: 2, background: '#ffffff' });
    const img = await pdf.embedPng(new Uint8Array(await png.arrayBuffer()));
    const page = pdf.addPage([595.28, 841.89]);
    page.drawImage(img, { x: 0, y: 0, width: 595.28, height: 841.89 });
  }
  pdf.setTitle(title); pdf.setCreator('Sales & Payroll');
  return new Blob([await pdf.save()], { type: 'application/pdf' });
}

/** Opens a WhatsApp chat with this number and a prefilled message (the user presses Send). */
export function openWhatsApp(phone, text) {
  const n = waNumber(phone);
  const url = `https://wa.me/${n}?text=${encodeURIComponent(text)}`;
  // Note: window.open(..., 'noopener') always returns null, so detach the opener manually.
  const w = window.open(url, '_blank');
  if (w) { try { w.opener = null; } catch { /* */ } } else { const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove(); }
}

/** Iraqi mobile → international for wa.me (07XXXXXXXXX → 9647XXXXXXXXX). */
export function waNumber(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('964')) return d;
  if (d.startsWith('0') && d.length === 11) return '964' + d.slice(1);
  return d;
}

/**
 * Share an image using the device share sheet (user picks WhatsApp and confirms).
 * Falls back to downloading the image and opening WhatsApp with a prefilled message.
 * Returns 'shared' | 'cancelled' | 'fallback' — never claims the message was sent.
 */
export async function shareImage(blob, filename, text, phone) {
  const file = new File([blob], filename, { type: blob.type || 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], text, title: filename }); return 'shared'; }
    catch (e) { if (e?.name === 'AbortError') return 'cancelled'; }
  }
  downloadBlob(blob, filename);
  const n = waNumber(phone);
  window.open(`https://wa.me/${n}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  return 'fallback';
}

export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
