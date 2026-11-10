/**
 * Monthly Financial Report -> a self-contained, paginated HTML document that expo-print turns into the PDF.
 *
 * Pure string building (no React Native, no filesystem, no network), so it is unit-testable in Node. Everything the PDF
 * shows comes from the MonthlyReport object: the same numbers as the preview and the CSV.
 *
 * Pagination is explicit: print engines cannot be trusted to number pages or repeat headers the same way on every device,
 * so pages are laid out here (heights estimated conservatively, in points) and each page carries its own footer with
 * "Page X of N". Tables repeat their header row on every page they continue onto. No row is ever dropped.
 */
import { luminanceOf, palette } from '../../tokens.ts';
import { formatDisplayDate, formatDisplayTime, localHm, localYmd } from './dateUtils.ts';
import { formatMinor } from '../ui/currency.ts';
import { REPORT_LOGO_PNG_BASE64 } from './reportLogo.ts';
import type { MonthlyReport, ReportCategory, ReportTransaction } from './monthlyReportService.ts';

export const PDF_PAGE = { width: 595, height: 842 } as const; // A4 in points

const MARGIN_X = 36;
const CONTENT_W = PDF_PAGE.width - MARGIN_X * 2; // 523
const FOOTER_H = 58;
const BODY_BOTTOM = PDF_PAGE.height - FOOTER_H;
const HERO_H = 120;
const SLIM_H = 40;
const BODY_TOP_FIRST = HERO_H + 16;
const BODY_TOP_NEXT = SLIM_H + 16;
const LINE = 11; // line-height of table text, pt

const INCOME = palette.accentText; // dark green: legible on white
const EXPENSE = palette.expenseText;
const NAVY = palette.navy;
const INK = palette.ink;
const MUTED = palette.muted;
const OTHER_COLOR = '#94A3B8';

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const safeColor = (c: string) => (/^#[0-9a-f]{3,8}$/i.test(c) ? c : OTHER_COLOR);
const pct = (tenths: number) => `${(tenths / 10).toFixed(1)}%`;
const n1 = (n: number) => (Math.round(n * 100) / 100).toString();

// ------------------------------------------------------------------------------------------------------- pie chart

export interface PieSlice { label: string; totalPaise: number; percentTenths: number; color: string }

/** At most 8 slices: the 7 largest categories, then everything else together as "Other". The full list is always in the table. */
export function pieSlicesFor(categories: ReportCategory[]): PieSlice[] {
  const total = categories.reduce((s, c) => s + c.totalPaise, 0);
  if (total <= 0) return [];
  const toSlice = (c: ReportCategory): PieSlice => ({ label: c.category, totalPaise: c.totalPaise, percentTenths: c.percentTenths, color: safeColor(c.color) });
  if (categories.length <= 8) return categories.map(toSlice);
  const head = categories.slice(0, 7).map(toSlice);
  const rest = categories.slice(7);
  const restTotal = rest.reduce((s, c) => s + c.totalPaise, 0);
  return [...head, { label: `Other (${rest.length} categories)`, totalPaise: restTotal, percentTenths: Math.round((restTotal * 1000) / total), color: OTHER_COLOR }];
}

const polar = (cx: number, cy: number, r: number, a: number): [number, number] => [cx + r * Math.cos(a), cy + r * Math.sin(a)];

/** Donut chart as inline SVG, sized by the slice totals. Empty input gives no chart (the caller shows an empty state). */
export function donutSvg(slices: PieSlice[], size: number, centerLabel: string, centerValue: string): string {
  const total = slices.reduce((s, x) => s + x.totalPaise, 0);
  if (!slices.length || total <= 0) return '';
  const c = size / 2; const ro = size / 2 - 2; const ri = ro * 0.58; const mid = (ro + ri) / 2;
  let angle = -Math.PI / 2;
  const parts: string[] = [];
  if (slices.length === 1) {
    parts.push(`<circle cx="${c}" cy="${c}" r="${n1(mid)}" fill="none" stroke="${slices[0].color}" stroke-width="${n1(ro - ri)}"/>`);
  } else {
    for (const s of slices) {
      const sweep = (s.totalPaise / total) * Math.PI * 2;
      const a0 = angle; const a1 = angle + sweep; angle = a1;
      const end = sweep > 0.02 ? a1 - 0.006 : a1; // hairline gap between slices
      const [x1, y1] = polar(c, c, ro, a0); const [x2, y2] = polar(c, c, ro, end);
      const [x3, y3] = polar(c, c, ri, end); const [x4, y4] = polar(c, c, ri, a0);
      const large = end - a0 > Math.PI ? 1 : 0;
      parts.push(`<path d="M${n1(x1)},${n1(y1)} A${n1(ro)},${n1(ro)} 0 ${large} 1 ${n1(x2)},${n1(y2)} L${n1(x3)},${n1(y3)} A${n1(ri)},${n1(ri)} 0 ${large} 0 ${n1(x4)},${n1(y4)} Z" fill="${s.color}"/>`);
      if (s.percentTenths >= 60) { // label only slices wide enough to hold it
        const [lx, ly] = polar(c, c, mid, (a0 + a1) / 2);
        const fill = luminanceOf(s.color) > 0.4 ? NAVY : '#FFFFFF';
        parts.push(`<text x="${n1(lx)}" y="${n1(ly + 2.5)}" text-anchor="middle" font-size="7" font-weight="700" fill="${fill}">${pct(s.percentTenths)}</text>`);
      }
    }
  }
  parts.push(`<text x="${c}" y="${c - 3}" text-anchor="middle" font-size="7" fill="${MUTED}">${escapeHtml(centerLabel)}</text>`);
  parts.push(`<text x="${c}" y="${c + 10}" text-anchor="middle" font-size="${centerValue.length > 11 ? 9 : 11}" font-weight="700" fill="${NAVY}">${escapeHtml(centerValue)}</text>`);
  return `<svg width="${size}pt" height="${size}pt" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Expense distribution by category">${parts.join('')}</svg>`;
}

// ------------------------------------------------------------------------------------------------------ pagination

interface Block { type: 'block'; html: string; h: number; pageBreakBefore?: boolean }
interface Table { type: 'table'; title: string; colgroup: string; head: string; headH: number; rows: { html: string; h: number }[]; foot?: { html: string; h: number }; pageBreakBefore?: boolean }
type Item = Block | Table;

const TITLE_H = 26;

/** Greedy word-wrap line count for an estimate of how tall a cell will be. cpl is deliberately conservative. */
export function wrapLines(text: string, cpl: number): number {
  let lines = 1; let used = 0;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let w = word.length;
    while (w > cpl) { if (used > 0) { lines += 1; used = 0; } lines += Math.ceil(w / cpl) - 1; w = w % cpl || cpl; }
    if (used === 0) used = w;
    else if (used + 1 + w <= cpl) used += 1 + w;
    else { lines += 1; used = w; }
  }
  return lines;
}

function paginate(items: Item[]): string[] {
  const pages: string[] = [];
  let html = ''; let used = 0; let top = BODY_TOP_FIRST;
  const avail = () => BODY_BOTTOM - top;
  const flush = () => { pages.push(html); html = ''; used = 0; top = BODY_TOP_NEXT; };
  const hasContent = () => html !== '';
  const tableTitle = (t: Table, cont: boolean) => `<div class="h2${cont ? ' cont' : ''}">${escapeHtml(t.title)}${cont ? ' <span>(continued)</span>' : ''}</div>`;
  const open = (t: Table, cont: boolean) => { html += `${tableTitle(t, cont)}<table class="t">${t.colgroup}<thead>${t.head}</thead><tbody>`; used += TITLE_H + t.headH; };

  for (const item of items) {
    if (item.pageBreakBefore && hasContent()) flush();
    if (item.type === 'block') {
      if (used + item.h > avail() && hasContent()) flush();
      html += item.html; used += item.h;
      continue;
    }
    const first = item.rows[0] ?? item.foot;
    if (used + TITLE_H + item.headH + (first?.h ?? 0) > avail() && hasContent()) flush();
    open(item, false);
    for (const row of item.rows) {
      if (used + row.h > avail()) { html += '</tbody></table>'; flush(); open(item, true); }
      html += row.html; used += row.h;
    }
    if (item.foot) {
      if (used + item.foot.h > avail()) { html += '</tbody></table>'; flush(); open(item, true); }
      html += item.foot.html; used += item.foot.h;
    }
    html += '</tbody></table>'; used += 14;
  }
  if (hasContent() || pages.length === 0) pages.push(html);
  return pages;
}

// ---------------------------------------------------------------------------------------------------------- content

function logoBadge(size: number): string {
  // The app's own logo asset, cropped to the symbol the same way src/ui/VelnoraLogo.tsx does, on a white badge.
  // The image data lives once in the stylesheet (.logo-img), not once per page.
  const W = 0.46; const H = 0.44; const L = 0.27; const T = 0.26;
  const symbol = size * 0.62; const image = symbol / W;
  return `<div class="badge" style="width:${size}pt;height:${size}pt"><div class="logo-img" role="img" aria-label="Velnora" `
    + `style="width:${n1(symbol)}pt;height:${n1(image * H)}pt;background-size:${n1(image)}pt ${n1(image)}pt;background-position:${n1(-image * L)}pt ${n1(-image * T)}pt"></div></div>`;
}

function generatedLabel(iso: string): string {
  const d = new Date(iso);
  return `${formatDisplayDate(localYmd(d))}, ${formatDisplayTime(localHm(d))}`;
}

function card(label: string, value: string, color: string, sub: string): string {
  const size = value.length <= 12 ? 14 : value.length <= 15 ? 12 : 10;
  return `<div class="card"><div class="cl">${escapeHtml(label)}</div><div class="cv" style="color:${color};font-size:${size}pt">${escapeHtml(value)}</div><div class="cs">${escapeHtml(sub)}</div></div>`;
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function categoryTable(title: string, cats: ReportCategory[], total: number, fmt: (p: number) => string, amountColor: string): Table {
  const rowH = 20;
  const rows = cats.map((c) => ({
    h: rowH + (wrapLines(c.category, 40) - 1) * LINE,
    html: `<tr><td><span class="dot" style="background:${safeColor(c.color)}"></span>${escapeHtml(c.category)}</td><td class="num">${c.count}</td><td class="num">${pct(c.percentTenths)}</td><td class="num" style="color:${amountColor}">${escapeHtml(fmt(c.totalPaise))}</td></tr>`,
  }));
  const totalCount = cats.reduce((s, c) => s + c.count, 0);
  return {
    type: 'table', title,
    colgroup: '<colgroup><col style="width:253pt"/><col style="width:70pt"/><col style="width:80pt"/><col style="width:120pt"/></colgroup>',
    head: '<tr><th>Category</th><th class="num">Transactions</th><th class="num">Share</th><th class="num">Amount</th></tr>', headH: 20,
    rows,
    foot: { h: 22, html: `<tr class="total"><td>Total</td><td class="num">${totalCount}</td><td class="num">${cats.length ? '100%' : ''}</td><td class="num" style="color:${amountColor}">${escapeHtml(fmt(total))}</td></tr>` },
  };
}

function transactionTable(report: MonthlyReport, fmt: (p: number) => string): Table {
  const withRefunds = report.summary.refundCount > 0;
  const w = withRefunds ? { date: 62, desc: 150, cat: 90, inc: 72, exp: 72, ref: 77 } : { date: 64, desc: 190, cat: 104, inc: 82, exp: 83, ref: 0 };
  const descCpl = Math.floor((w.desc - 10) / 4.8); const catCpl = Math.floor((w.cat - 10) / 4.8); const refCpl = Math.floor((w.desc - 10) / 4.2);
  const cell = (paise: number, color: string) => (paise ? `<td class="num" style="color:${color}">${escapeHtml(fmt(paise))}</td>` : '<td class="num dash">&ndash;</td>');
  const rows = report.transactions.map((t: ReportTransaction) => {
    const descLines = wrapLines(t.description, descCpl) + (t.reference ? Math.ceil(`Ref: ${t.reference}`.length / refCpl) : 0);
    const lines = Math.max(descLines, wrapLines(t.category, catCpl));
    return {
      h: lines * LINE + 10,
      html: `<tr><td class="date">${escapeHtml(formatDisplayDate(t.date))}</td>`
        + `<td class="desc">${escapeHtml(t.description)}${t.reference ? `<div class="ref">Ref: ${escapeHtml(t.reference)}</div>` : ''}</td>`
        + `<td>${escapeHtml(t.category)}</td>${cell(t.incomePaise, INCOME)}${cell(t.expensePaise, EXPENSE)}${withRefunds ? cell(t.refundPaise, NAVY) : ''}</tr>`,
    };
  });
  const s = report.summary;
  return {
    type: 'table', pageBreakBefore: true, title: `Transactions (${report.meta.transactionCount})`,
    colgroup: `<colgroup><col style="width:${w.date}pt"/><col style="width:${w.desc}pt"/><col style="width:${w.cat}pt"/><col style="width:${w.inc}pt"/><col style="width:${w.exp}pt"/>${withRefunds ? `<col style="width:${w.ref}pt"/>` : ''}</colgroup>`,
    head: `<tr><th>Date</th><th>Description</th><th>Category</th><th class="num">Income</th><th class="num">Expense</th>${withRefunds ? '<th class="num">Refund</th>' : ''}</tr>`, headH: 22,
    rows,
    foot: { h: 24, html: `<tr class="total"><td colspan="3">Total</td><td class="num" style="color:${INCOME}">${escapeHtml(fmt(s.incomePaise))}</td><td class="num" style="color:${EXPENSE}">${escapeHtml(fmt(s.expensePaise))}</td>${withRefunds ? `<td class="num">${escapeHtml(fmt(s.refundPaise))}</td>` : ''}</tr>` },
  };
}

const CSS = `
@page { size: ${PDF_PAGE.width}pt ${PDF_PAGE.height}pt; margin: 0; }
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
html, body { margin: 0; padding: 0; background: #fff; }
body { font-family: Roboto, "Helvetica Neue", Helvetica, Arial, sans-serif; color: ${INK}; font-size: 8pt; line-height: ${LINE}pt; }
.page { position: relative; width: ${PDF_PAGE.width}pt; height: ${PDF_PAGE.height}pt; page-break-after: always; break-after: page; background: #fff; }
.page:last-child { page-break-after: auto; break-after: auto; }
.hero { height: ${HERO_H}pt; background: ${NAVY}; color: #fff; padding: 22pt ${MARGIN_X}pt 0; position: relative; }
.slim { height: ${SLIM_H}pt; background: ${NAVY}; color: #fff; padding: 0 ${MARGIN_X}pt; display: flex; align-items: center; justify-content: space-between; font-size: 8.5pt; }
.badge { background: #fff; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex: none; }
.logo-img { background-image: url(data:image/png;base64,${REPORT_LOGO_PNG_BASE64}); background-repeat: no-repeat; }
.brand { display: flex; align-items: center; }
.brand .word { font-size: 15pt; font-weight: 700; letter-spacing: 1.5pt; margin-left: 10pt; }
.hero h1 { margin: 16pt 0 0; font-size: 20pt; line-height: 24pt; font-weight: 700; }
.hero .gen { margin-top: 3pt; font-size: 8pt; color: ${palette.onNavyMuted}; }
.hero .period { position: absolute; right: ${MARGIN_X}pt; top: 24pt; text-align: right; }
.hero .period .k { font-size: 7.5pt; letter-spacing: 1pt; text-transform: uppercase; color: ${palette.onNavyMuted}; }
.hero .period .v { font-size: 15pt; font-weight: 700; margin-top: 2pt; }
.slim .b { display: flex; align-items: center; font-weight: 700; letter-spacing: 1pt; }
.body { position: absolute; left: ${MARGIN_X}pt; right: ${MARGIN_X}pt; }
.cards { display: flex; justify-content: space-between; margin-bottom: 14pt; }
.card { width: 123pt; height: 62pt; border: 0.75pt solid ${palette.border}; border-radius: 6pt; padding: 8pt 10pt; border-top: 3pt solid ${NAVY}; }
.card:nth-child(1) { border-top-color: ${palette.emerald}; } .card:nth-child(2) { border-top-color: ${palette.danger}; }
.cl { font-size: 7pt; letter-spacing: 0.8pt; text-transform: uppercase; color: ${MUTED}; }
.cv { margin-top: 5pt; font-weight: 700; line-height: 17pt; white-space: nowrap; }
.cs { margin-top: 1pt; font-size: 7pt; color: ${MUTED}; }
.h2 { font-size: 11pt; font-weight: 700; color: ${NAVY}; height: ${TITLE_H}pt; padding-top: 6pt; }
.h2 span { font-size: 8pt; font-weight: 400; color: ${MUTED}; }
.pie { display: flex; height: 180pt; margin-bottom: 12pt; }
.legend { margin-left: 22pt; flex: 1; }
.legend .hi { font-size: 8pt; color: ${MUTED}; margin-bottom: 8pt; }
.legend .hi b { color: ${INK}; }
.lg { display: flex; align-items: flex-start; padding: 3pt 0; border-bottom: 0.5pt solid ${palette.border}; }
.lg .n { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.lg .p { width: 36pt; text-align: right; color: ${MUTED}; font-variant-numeric: tabular-nums; }
.lg .a { width: 78pt; text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; }
.dot { display: inline-block; width: 7pt; height: 7pt; border-radius: 50%; margin-right: 6pt; vertical-align: baseline; flex: none; }
.lg .dot { margin-top: 2pt; }
.empty { border: 0.75pt dashed ${palette.border}; border-radius: 6pt; padding: 16pt; text-align: center; color: ${MUTED}; margin-bottom: 12pt; }
.notes { border-left: 2.5pt solid ${palette.warning}; background: ${palette.canvas}; padding: 6pt 10pt; font-size: 7.5pt; color: ${MUTED}; margin-bottom: 10pt; }
table.t { width: ${CONTENT_W}pt; border-collapse: collapse; table-layout: fixed; }
table.t th { text-align: left; background: ${NAVY}; color: #fff; font-size: 7.5pt; font-weight: 600; letter-spacing: 0.4pt; padding: 5pt 5pt; height: 20pt; }
table.t td { padding: 4.5pt 5pt; border-bottom: 0.5pt solid ${palette.border}; vertical-align: top; overflow-wrap: anywhere; }
table.t tr { page-break-inside: avoid; break-inside: avoid; }
table.t th.num, table.t td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
table.t td.date { white-space: nowrap; color: ${MUTED}; }
table.t td.dash { color: #B0BAC6; }
table.t td .ref { font-size: 7pt; color: ${MUTED}; }
table.t tr.total td { font-weight: 700; border-top: 1pt solid ${NAVY}; border-bottom: none; background: ${palette.canvas}; height: 22pt; vertical-align: middle; }
.footer { position: absolute; left: ${MARGIN_X}pt; right: ${MARGIN_X}pt; bottom: 14pt; border-top: 0.75pt solid ${palette.border}; padding-top: 5pt; font-size: 6.5pt; line-height: 9pt; color: ${MUTED}; }
.footer .row { display: flex; justify-content: space-between; margin-top: 3pt; font-size: 7pt; color: ${INK}; }
`;

/** The whole PDF document as HTML. `format` renders integer paise as money (default: the active display currency). */
export function renderReportHtml(report: MonthlyReport, format: (paise: number) => string = formatMinor): string {
  const s = report.summary; const fmt = format;
  const netColor = s.netPaise < 0 ? EXPENSE : s.netPaise > 0 ? INCOME : NAVY;
  const items: Item[] = [];

  items.push({
    type: 'block', h: 76, html: `<div class="cards">`
      + card('Total income', fmt(s.incomePaise), INCOME, count(s.incomeCount, 'transaction'))
      + card('Total expenses', fmt(s.expensePaise), EXPENSE, count(s.expenseCount, 'transaction'))
      + card('Net cash flow', fmt(s.netPaise), netColor, s.refundPaise ? `incl. ${fmt(s.refundPaise)} refunds` : 'income - expenses')
      + card('Transactions', String(report.meta.transactionCount), NAVY, 'listed in this report') + '</div>',
  });

  const slices = pieSlicesFor(report.expenseCategories);
  if (slices.length) {
    const top = report.highestExpenseCategory!;
    const legend = slices.map((x) => `<div class="lg"><span class="dot" style="background:${x.color}"></span><span class="n">${escapeHtml(x.label)}</span><span class="p">${pct(x.percentTenths)}</span><span class="a">${escapeHtml(fmt(x.totalPaise))}</span></div>`).join('');
    items.push({
      type: 'block', h: TITLE_H + 192,
      html: `<div class="h2">Spending by category</div><div class="pie">${donutSvg(slices, 170, 'Total spent', fmt(s.expensePaise))}<div class="legend"><div class="hi">Highest spending: <b>${escapeHtml(top.category)}</b> &middot; ${escapeHtml(fmt(top.totalPaise))} (${pct(top.percentTenths)})</div>${legend}</div></div>`,
    });
  } else {
    items.push({ type: 'block', h: 78, html: `<div class="h2">Spending by category</div><div class="empty">No spending was recorded for ${escapeHtml(report.meta.monthLabel)}.</div>` });
  }

  if (report.notes.length) {
    const lines = report.notes.reduce((n, t) => n + wrapLines(t, 105), 0);
    items.push({ type: 'block', h: lines * 10 + 20, html: `<div class="notes">${report.notes.map((n) => `<div>${escapeHtml(n)}</div>`).join('')}</div>` });
  }
  if (report.expenseCategories.length) items.push(categoryTable('Expense categories', report.expenseCategories, s.expensePaise, fmt, EXPENSE));
  if (report.incomeCategories.length) items.push(categoryTable('Income by category', report.incomeCategories, s.incomePaise, fmt, INCOME));
  if (report.transactions.length) items.push(transactionTable(report, fmt));
  else items.push({ type: 'block', h: 80, pageBreakBefore: false, html: `<div class="h2">Transactions</div><div class="empty">There are no transactions in ${escapeHtml(report.meta.monthLabel)}.</div>` });

  const bodies = paginate(items);
  const total = bodies.length;
  const period = escapeHtml(report.meta.monthLabel);
  const pagesHtml = bodies.map((body, i) => {
    const band = i === 0
      ? `<div class="hero"><div class="brand">${logoBadge(40)}<div class="word">VELNORA</div></div><h1>${escapeHtml(report.meta.title)}</h1>`
        + `<div class="gen">Generated ${escapeHtml(generatedLabel(report.meta.generatedAtIso))} &middot; Currency: ${escapeHtml(report.meta.currencyCode)}</div>`
        + `<div class="period"><div class="k">Statement period</div><div class="v">${period}</div></div></div>`
      : `<div class="slim"><div class="b"><span style="display:flex;margin-right:8pt">${logoBadge(24)}</span>VELNORA</div><div>${escapeHtml(report.meta.title)} &middot; ${period}</div></div>`;
    return `<section class="page">${band}<div class="body" style="top:${i === 0 ? BODY_TOP_FIRST : BODY_TOP_NEXT}pt">${body}</div>`
      + `<div class="footer"><div>This report was generated by Velnora from the transactions recorded on this device. It is a personal record, not an official bank statement, and may not include transactions that were never recorded in Velnora.</div>`
      + `<div class="row"><span>Velnora &middot; Reporting period: ${period}</span><span>Page ${i + 1} of ${total}</span></div></div></section>`;
  }).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>${escapeHtml(`Velnora ${report.meta.title} ${report.meta.monthLabel}`)}</title><style>${CSS}</style></head><body>${pagesHtml}</body></html>`;
}

/** Number of pages the layout needs (also what the footer prints). Exposed for tests. */
export function reportPageCount(html: string): number {
  return (html.match(/<section class="page">/g) ?? []).length;
}
