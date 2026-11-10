import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { palette } from '../../theme';
import { type } from '../../typography';
import { Button, Card, Chip, EmptyBlock, SectionLabel, formatPaise, type Colors } from '../ui/common';
import { currentMonth } from '../services/budgetService';
import { MONTH_SHORT, formatDisplayDate } from '../services/dateUtils';
import { getServiceDb } from '../services/transactionService';
import { buildMonthlyReport, listReportMonths, parseReportMonth, reportMonthKey, type MonthlyReport } from '../services/monthlyReportService';
import { exportReportCsv, exportReportPdf, type ExportResult } from '../services/monthlyReportExport';
import { clearReportFiles, expoReportExportPort } from '../services/monthlyReportExportExpo';
import { pct } from './PieChart';

const PREVIEW_ROWS = 25;

/** Monthly Financial Report: pick a month, review the figures and transactions, export a PDF or CSV. All local. */
export function MonthlyReportView({ scope, colors, refreshKey }: { scope: string | null; colors: Colors; refreshKey: number }) {
  const now = currentMonth();
  const [months, setMonths] = useState<string[]>([]);
  const [month, setMonth] = useState(now);
  const [report, setReport] = useState<MonthlyReport | null>(null);
  const [loadError, setLoadError] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState<'pdf' | 'csv' | null>(null);
  const busyRef = useRef(false);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => { void clearReportFiles(); }, []);

  useEffect(() => {
    let live = true;
    listReportMonths(getServiceDb(), scope).then((m) => { if (live) setMonths(m); }).catch(() => { if (live) setMonths([]); });
    return () => { live = false; };
  }, [scope, refreshKey]);

  useEffect(() => {
    let live = true;
    setReport(null); setLoadError(''); setShowAll(false); setFeedback(null);
    buildMonthlyReport(getServiceDb(), scope, month).then((r) => { if (live) setReport(r); })
      .catch(() => { if (live) setLoadError('This report could not be built. Please try again.'); });
    return () => { live = false; };
  }, [scope, month, refreshKey]);

  // Selectable range: from the oldest month with data (or this month) to the newest month with data (or this month).
  const all = [...months, now].sort();
  const first = all[0]; const last = all[all.length - 1];
  const firstYear = parseReportMonth(first).year; const lastYear = parseReportMonth(last).year;
  const years: number[] = []; for (let y = lastYear; y >= firstYear; y -= 1) years.push(y);
  const { year: selYear, monthNumber: selMonth } = parseReportMonth(month);
  const monthsOfYear: number[] = [];
  for (let m = 1; m <= 12; m += 1) { const key = reportMonthKey(selYear, m); if (key >= first && key <= last) monthsOfYear.push(m); }

  const pickYear = (y: number) => {
    // Keep the same month number when possible, otherwise the nearest selectable month of that year.
    const candidates: number[] = []; for (let m = 1; m <= 12; m += 1) { const key = reportMonthKey(y, m); if (key >= first && key <= last) candidates.push(m); }
    const m = candidates.includes(selMonth) ? selMonth : candidates.reduce((a, b) => (Math.abs(b - selMonth) < Math.abs(a - selMonth) ? b : a), candidates[0]);
    setMonth(reportMonthKey(y, m));
  };

  const run = async (kind: 'pdf' | 'csv') => {
    if (!report || busyRef.current) return; // one export at a time: repeated taps do nothing
    busyRef.current = true; setBusy(kind); setFeedback(null);
    let result: ExportResult;
    try { result = await (kind === 'pdf' ? exportReportPdf : exportReportCsv)(expoReportExportPort, report); }
    catch { result = { ok: false, error: 'The export failed. Please try again.' }; }
    busyRef.current = false; setBusy(null);
    if (result.ok) setFeedback({ kind: 'ok', text: `${result.fileName} is ready. Choose where to save or send it.` });
    else if (!result.cancelled) setFeedback({ kind: 'error', text: result.error });
  };

  const money = (p: number) => formatPaise(p);
  const hasMonthData = months.includes(month);
  const rows = report ? (showAll ? report.transactions : report.transactions.slice(0, PREVIEW_ROWS)) : [];

  return <View>
    <SectionLabel colors={colors} style={{ marginTop: 0 }}>Year</SectionLabel>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }}>
      {years.map((y) => <Chip key={y} label={String(y)} active={y === selYear} onPress={() => pickYear(y)} colors={colors} />)}
    </ScrollView>
    <SectionLabel colors={colors}>Month</SectionLabel>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginBottom: 4 }}>
      {monthsOfYear.map((m) => <Chip key={m} label={`${MONTH_SHORT[m - 1]}${months.includes(reportMonthKey(selYear, m)) ? ' •' : ''}`} active={m === selMonth} onPress={() => setMonth(reportMonthKey(selYear, m))} colors={colors} />)}
    </View>
    <Text style={{ ...type.caption, color: colors.muted, marginBottom: 12 }}>• marks months with transactions</Text>

    {loadError ? <Text style={{ color: palette.expenseText, marginBottom: 12 }} accessibilityLiveRegion="polite">{loadError}</Text> : null}
    {!report && !loadError ? <Text style={{ ...type.body, color: colors.muted, marginVertical: 24, textAlign: 'center' }} accessibilityLiveRegion="polite">Preparing report…</Text> : null}

    {report ? <View>
      <Text style={{ ...type.cardTitle, color: colors.text, marginBottom: 8 }}>{report.meta.monthLabel}</Text>
      {report.transactions.length === 0
        ? <EmptyBlock title={hasMonthData ? 'Nothing to report' : 'No transactions this month'} colors={colors}
          text={hasMonthData ? 'This month only has own transfers or possible duplicates, which are not counted.' : 'There are no transactions dated in this month, so there is nothing to export.'} />
        : <View>
          <View style={{ flexDirection: 'row', gap: 10, marginBottom: 10 }}>
            <Card colors={colors} style={{ flex: 1, padding: 12 }}><Text style={{ ...type.caption, color: colors.muted }}>Income</Text><Text style={{ ...type.amountMd, color: palette.accentText, marginTop: 2 }}>{money(report.summary.incomePaise)}</Text><Text style={{ ...type.caption, color: colors.muted }}>{report.summary.incomeCount} txns</Text></Card>
            <Card colors={colors} style={{ flex: 1, padding: 12 }}><Text style={{ ...type.caption, color: colors.muted }}>Expenses</Text><Text style={{ ...type.amountMd, color: palette.expenseText, marginTop: 2 }}>{money(report.summary.expensePaise)}</Text><Text style={{ ...type.caption, color: colors.muted }}>{report.summary.expenseCount} txns</Text></Card>
          </View>
          <Card colors={colors} style={{ marginBottom: 10 }}>
            <Text style={{ ...type.caption, color: colors.muted }}>Net cash flow</Text>
            <Text style={{ ...type.amountLg, color: report.summary.netPaise < 0 ? palette.expenseText : colors.text }}>{money(report.summary.netPaise)}</Text>
            <Text style={{ ...type.caption, color: colors.muted, marginTop: 2 }}>{report.meta.transactionCount} transactions{report.summary.refundPaise ? ` · includes ${money(report.summary.refundPaise)} refunds` : ''}</Text>
          </Card>
          {report.notes.map((n) => <Text key={n} style={{ ...type.caption, color: colors.muted, marginBottom: 4 }}>{n}</Text>)}

          <SectionLabel colors={colors}>Expense categories</SectionLabel>
          {report.expenseCategories.length === 0
            ? <Text style={{ ...type.body, color: colors.muted }}>No spending recorded this month.</Text>
            : <Card colors={colors}>{report.expenseCategories.map((c) => <View key={c.category} style={{ flexDirection: 'row', alignItems: 'center', minHeight: 36, paddingVertical: 4 }}>
              <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: c.color, marginRight: 10 }} />
              <Text style={{ ...type.body, flex: 1, color: colors.text }}>{c.category}</Text>
              <Text style={{ ...type.caption, color: colors.muted, marginRight: 10, fontVariant: ['tabular-nums'] }}>{pct(c.percentTenths)}</Text>
              <Text style={{ ...type.amountSm, color: colors.text }}>{money(c.totalPaise)}</Text>
            </View>)}</Card>}

          <SectionLabel colors={colors}>Transactions included</SectionLabel>
          <Card colors={colors}>
            {rows.map((t) => <View key={t.id} style={{ flexDirection: 'row', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border }}>
              <View style={{ flex: 1, paddingRight: 10 }}>
                <Text style={{ ...type.body, color: colors.text, fontWeight: '500' }}>{t.description}</Text>
                <Text style={{ ...type.caption, color: colors.muted }}>{formatDisplayDate(t.date)} · {t.category}{t.kind === 'income' || t.typeLabel === 'Expense' ? '' : ` · ${t.typeLabel}`}</Text>
                {t.reference ? <Text style={{ ...type.caption, color: colors.muted }}>Ref: {t.reference}</Text> : null}
              </View>
              <Text style={{ ...type.amountSm, color: t.kind === 'expense' ? palette.expenseText : palette.accentText, fontVariant: ['tabular-nums'] }}>{t.kind === 'expense' ? '-' : '+'}{money(t.expensePaise || t.incomePaise || t.refundPaise)}</Text>
            </View>)}
            {report.transactions.length > PREVIEW_ROWS
              ? <Button title={showAll ? 'Show fewer' : `Show all ${report.transactions.length}`} kind="ghost" onPress={() => setShowAll((v) => !v)} />
              : null}
          </Card>
          <Text style={{ ...type.caption, color: colors.muted, marginTop: 6 }}>The PDF and CSV include all {report.transactions.length} transactions, not just the preview.</Text>

          <View style={{ marginTop: 14 }}>
            <Button title="Export PDF" onPress={() => void run('pdf')} busy={busy === 'pdf'} disabled={busy !== null} />
            <Button title="Export CSV" kind="ghost" onPress={() => void run('csv')} busy={busy === 'csv'} disabled={busy !== null} />
          </View>
        </View>}
      {feedback ? <Text style={{ color: feedback.kind === 'error' ? palette.expenseText : palette.accentText, marginTop: 10 }} accessibilityLiveRegion="polite">{feedback.text}</Text> : null}
    </View> : null}
  </View>;
}
