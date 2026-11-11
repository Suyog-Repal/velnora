import { StatusBar } from 'expo-status-bar';
import { Alert, Animated, AppState, Easing, Keyboard, KeyboardAvoidingView, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Circle, Defs, LinearGradient, Path, Stop } from 'react-native-svg';
import { useEffect, useMemo, useRef, useState } from 'react';
import { clearSession, loadSession, login, logout, refreshSessionShared as refreshSession, register, requestPasswordReset, saveSession, type Session } from './auth';
import { restoreSession } from './src/services/sessionRestore';
import { getGuestDataSummary, importGuestData, isGuestModeChosen, setGuestModeChosen } from './src/services/guestModeService';
import { addSmsStagedListener, configureSupportedSenderPatterns, getNativeReviewNotifier } from './sms';
import { REVIEW_SETTLE_MS, cancelReviewNotification, clearReviewNotifications, runReviewPass, setReviewNotifierPort } from './src/services/reviewNotifications';
import { createReviewLinkRouter, resolveReviewTarget, type ReviewLink } from './src/services/reviewLinks';
import { clearSmsOwner, drainNativeStagedSms, recordSmsOwner } from './src/services/smsStagingService';
import { LocalDataSection } from './src/components/LocalDataSection';
import { SmsStagingStatusSection } from './src/components/SmsStagingStatusSection';
import { DEFAULT_SMS_RULE, parseSmsTransaction } from './transactionParser';
import { type } from './typography';
import { applyAccent, applyScheme, elevation, layout, radius, tint, palette, useAccent, useCurrency, useResolvedScheme, useThemeMode, type ThemeMode } from './theme';
import { ProfileView } from './src/screens/ProfileView';
import { PeopleView } from './src/screens/PeopleView';
import { findOpenForPerson, outstandingPaise, recordPayment } from './src/services/expectedPaymentService';
import { CurrencySheet, SettingsPage } from './src/screens/SettingsPages';
import { CURRENCIES } from './src/ui/currency';
import { ArrowDownLeft, ArrowUpRight, Bell, Chart, ChevronRight, CirclePlus, Eye, EyeOff, Home, KeyRound, LayoutGrid, LockKeyhole, LogOut, PiggyBank, Plus, ScanLine, Search, Settings, Sliders, Target, UserRound, Users, WalletCards, X } from './icons';
import {
  initTransactionService,
  getTransactions,
  getGuestTransactions,
  getCategories,
  addTransaction as recordAddTransaction,
  addSmsTransaction as recordAddSmsTransaction,
  syncPendingTransactions,
} from './src/services/transactionService';
import type { Direction, TransactionEntity } from './src/db/types';
import { getServiceDb, onSyncResult, setPostSyncHook } from './src/services/transactionService';
import { listCategories, type CategoryView } from './src/services/categoryService';
import { uploadPendingReceipts } from './src/services/receiptService';
import { expoReceiptFs, expoReceiptUploader } from './src/services/receiptFiles';
import { setSyncSessionRefresher, startSyncEngine, stopSyncEngine, triggerSync } from './src/services/syncEngine';
import { createSessionRefresher } from './src/services/sessionRefresh';
import { API_URL } from './auth';
import { Chip, Input, Sheet, TypeToggle, currencySymbol, readableOn, useOnline } from './src/ui/common';
import { EMPTY_CASH_FLOW, EMPTY_LEDGER_HEALTH, getCashFlowSummary, getLedgerHealth, type CashFlowSummary, type LedgerHealth } from './src/services/cashFlowService';
import { Splash } from './src/ui/Splash';
import { VelnoraLogo } from './src/ui/VelnoraLogo';
import { PermissionSetup } from './src/components/PermissionSetup';
import { AccountsSheet, CompleteTransactionSheet, ReviewSheet, StatementImportSheet } from './src/screens/LedgerSheets';
import { DateField } from './src/ui/CalendarDatePicker';
import { TimeField } from './src/ui/TimePicker';
import { ToastHost, notices, showToast } from './src/ui/Toast';
import { useGreeting } from './src/ui/useGreeting';
import { localHm, localYmd } from './src/services/dateUtils';
import { parseLocalDateTime } from './src/services/transactionDetails';
import { SpendingOverview } from './src/screens/SpendingOverview';
import { formatAmount, formatMinor, setActiveCurrency } from './src/ui/currency';
import { TransactionsView } from './src/screens/TransactionsView';
import { TransactionSheet } from './src/screens/TransactionSheet';
import { AnalyticsView } from './src/screens/AnalyticsView';
import { BudgetsView } from './src/screens/BudgetsView';
import { ReceiptScan } from './src/screens/ReceiptScan';
import { CategoryManager, MerchantNamesManager } from './src/screens/ManageSheets';

type Tab = 'home' | 'transactions' | 'analytics' | 'budgets' | 'people' | 'profile';
type Transaction = TransactionEntity & { date: string; referenceId?: string };
type Contact = { name: string; received: number; paid: number; count: number };

const DEFAULT_CATEGORIES = ['Food & Dining', 'Groceries', 'Transportation', 'Bills & Utilities', 'Other Expenses'];
const DEFAULT_INCOME_CATEGORIES = ['Salary', 'Other Income'];
const smsRules = [DEFAULT_SMS_RULE];
const TAB_ORDER: Tab[] = ['home', 'transactions', 'analytics', 'budgets', 'people', 'profile'];

function toUiTransaction(entity: TransactionEntity): Transaction {
  return {
    ...entity,
    date: entity.transaction_date,
    referenceId: entity.reference_id ?? undefined,
  };
}

function money(value: number) { return formatAmount(value); }

export default function App() {
  // The SMS permission explanation waits until the splash has finished so the two never overlap.
  const [splashDone, setSplashDone] = useState(false);
  return <View style={{ flex: 1 }}><AppInner /><Splash onFinish={() => setSplashDone(true)} /><PermissionSetup enabled={splashDone} /></View>;
}

function AppInner() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authScreen, setAuthScreen] = useState<'welcome' | 'signup' | 'signin' | 'forgot'>('welcome');
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState('');
  const [authNotice, setAuthNotice] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [categoriesList, setCategoriesList] = useState<string[]>(DEFAULT_CATEGORIES);
  const [tab, setTab] = useState<Tab>('home');
  const [showForm, setShowForm] = useState(false);
  const [direction, setDirection] = useState<Direction>('expense');
  const [amount, setAmount] = useState('');
  const [counterparty, setCounterparty] = useState('');
  const [category, setCategory] = useState(DEFAULT_CATEGORIES[0]);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false); // blocks a second tap before the `saving` state re-renders
  const [amountFocused, setAmountFocused] = useState(false);
  const [cashFlow, setCashFlow] = useState<CashFlowSummary>(EMPTY_CASH_FLOW);
  const [ledgerHealth, setLedgerHealth] = useState<LedgerHealth>(EMPTY_LEDGER_HEALTH);
  const [showReview, setShowReview] = useState(false);
  const [reviewTxId, setReviewTxId] = useState<string | null>(null);
  const [showAccounts, setShowAccounts] = useState(false);
  const [showImport, setShowImport] = useState<'csv' | 'pdf' | null>(null);
  const sessionRefresher = useRef<((stale: Session) => Promise<Session | null>) | null>(null);
  const [smsStatusTick, setSmsStatusTick] = useState(0);
  const [guestMode, setGuestMode] = useState(false);
  const [showAuth, setShowAuth] = useState(false);
  const [dbReady, setDbReady] = useState(false);
  const [sessionStale, setSessionStale] = useState(false);
  const [importPrompt, setImportPrompt] = useState<{ count: number } | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importNotice, setImportNotice] = useState('');
  const [catViews, setCatViews] = useState<CategoryView[]>([]);
  const [txLoading, setTxLoading] = useState(true);
  const [openTx, setOpenTx] = useState<TransactionEntity | null>(null);
  const [showScan, setShowScan] = useState(false);
  const [showCats, setShowCats] = useState(false);
  const [showAliases, setShowAliases] = useState(false);
  const [drillCategory, setDrillCategory] = useState<string | null>(null);
  const [dataTick, setDataTick] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [showCurrency, setShowCurrency] = useState(false);
  const online = useOnline();
  const scope = session?.user.id ?? null;
  const greeting = useGreeting();
  // Date/time for a new transaction. Until the person picks one, the transaction is stamped with the moment of saving.
  const [txDate, setTxDate] = useState(localYmd());
  const [txTime, setTxTime] = useState(localHm());
  const [dateTouched, setDateTouched] = useState(false);
  const [timeTouched, setTimeTouched] = useState(false);
  // "Synced" / "saved offline" notices come from real sync outcomes only.
  useEffect(() => onSyncResult((summary) => notices.syncResult(summary)), []);

  // Screen transition: content slides in from the direction of travel while fading in.
  const enter = useRef(new Animated.Value(1)).current;
  const slideDir = useRef(1);
  const changeTab = (next: Tab) => {
    if (next === tab) return;
    slideDir.current = TAB_ORDER.indexOf(next) >= TAB_ORDER.indexOf(tab) ? 1 : -1;
    if (next !== 'transactions') setDrillCategory(null);
    setTab(next);
    enter.stopAnimation();
    enter.setValue(0);
    Animated.timing(enter, { toValue: 1, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  };
  const [mode, setMode] = useThemeMode();
  const [accent, setAccent] = useAccent();
  const [currency, setCurrency] = useCurrency(setActiveCurrency);
  const scheme = useResolvedScheme(mode);
  // The accent colour is baked into StyleSheet objects: rebuild them whenever the accent changes (before children render).
  if (stylesAccent !== `${accent}-${scheme}`) { applyAccent(accent); applyScheme(scheme === 'dark'); styles = buildStyles(); stylesAccent = `${accent}-${scheme}`; }

  const dark = scheme === 'dark';
  const narrow = useWindowDimensions().width < 360; // small phones: tighter gutters so amounts keep room
  const colors = dark ? { canvas: palette.darkCanvas, card: palette.darkCard, border: palette.darkBorder, text: palette.darkText, muted: palette.darkMuted } : { canvas: palette.canvas, card: palette.card, border: palette.border, text: palette.ink, muted: palette.muted };
  const contacts = useMemo(() => {
    const map = new Map<string, Contact>();
    transactions.forEach((item) => { const current = map.get(item.counterparty) ?? { name: item.counterparty, received: 0, paid: 0, count: 0 }; current.count += 1; if (item.direction === 'income') current.received += item.amount; else current.paid += item.amount; map.set(item.counterparty, current); });
    return [...map.values()].sort((a, b) => b.count - a.count);
  }, [transactions]);

  // After each sync, upload receipts whose transactions the server now has, then sync the resulting reference.
  useEffect(() => {
    setPostSyncHook(async (s) => {
      const r = await uploadPendingReceipts(getServiceDb(), expoReceiptFs, expoReceiptUploader(API_URL), s);
      if (r.uploaded > 0) await triggerSync(s);
    });
    return () => setPostSyncHook(null);
  }, []);

  // The server definitively rejected the refresh token: this is "sign in again", never a silent switch to guest mode. The persisted
  // guest choice is cleared too, otherwise an earlier "continue without an account" would turn this into guest mode on its own.
  const endSessionToSignIn = () => {
    setAuthNotice('Your session has ended. Sign in again; your data on this device is preserved.');
    void setGuestModeChosen(false).catch(() => undefined);
    setGuestMode(false); setAuthScreen('signin'); setShowAuth(true);
  };

  // A sync rejected with 401 (15-minute access token expired) refreshes the session once, then retries; see sessionRefresh.ts.
  useEffect(() => {
    const refresher = createSessionRefresher<Session>({
      loadStored: loadSession,
      refresh: refreshSession,
      onRefreshed: (next) => setSession((current) => (current && current.user.id === next.user.id ? next : current)),
      onRejected: (rejected) => {
        void clearSession();
        setSession((current) => (current?.user.id === rejected.user.id ? null : current));
        endSessionToSignIn();
      },
    });
    sessionRefresher.current = refresher;
    setSyncSessionRefresher((stale) => refresher(stale as Session)); // the app only ever passes full Sessions to triggerSync
    return () => { sessionRefresher.current = null; setSyncSessionRefresher(null); };
  }, []);

  // Restore the stored session without destroying it on a transient failure (offline, 5xx).
  // Only an explicit server rejection of the refresh token ends the session; local data is never touched.
  useEffect(() => {
    // The first screen comes from local data at once; the refresh runs behind it, so a slow or sleeping server never delays launch.
    // A keystore that is not ready yet throws; that is not "no session". Look twice before treating it as signed out.
    loadSession().catch(() => new Promise<Session | null>((resolve) => setTimeout(() => loadSession().then(resolve, () => resolve(null)), 600))).then((stored) => {
      if (stored) setSession(stored);
      setAuthReady(true);
      if (!stored) return;
      void restoreSession(stored, refreshSession).then(async (result) => {
        if (result.status === 'expired') { await clearSession(); endSessionToSignIn(); }
        // Only apply this to the session it was started for (the person may have signed out meanwhile).
        setSession((current) => (current?.refresh_token === stored.refresh_token ? result.session : current));
        setSessionStale(result.status === 'offline');
      });
    }).catch(() => setAuthReady(true));
  }, []);

  // Initialize SQLite storage and load local categories
  useEffect(() => {
    let isMounted = true;
    initTransactionService().then(async () => {
      const chosen = await isGuestModeChosen();
      if (isMounted) { setGuestMode(chosen); setDbReady(true); }
      const storedCats = await getCategories();
      if (isMounted && storedCats.length > 0) {
        setCategoriesList([...new Set(storedCats.map((c) => c.name))]);
      }
    }).catch((err) => {
      console.error('Failed to initialize local SQLite storage:', err);
      if (isMounted) setDbReady(true);
    });
    return () => { isMounted = false; };
  }, []);

  // Reactive transaction loading: scoped to the signed-in user, or to local guest records when in guest mode.
  const inGuest = !session && guestMode && !showAuth;
  useEffect(() => {
    let isMounted = true;
    if (session?.user?.id) {
      void getTransactions(session.user.id).then((storedTx) => {
        if (isMounted) { setTransactions(storedTx.map(toUiTransaction)); setTxLoading(false); }
      });
    } else if (inGuest && dbReady) {
      void getGuestTransactions().then((storedTx) => {
        if (isMounted) { setTransactions(storedTx.map(toUiTransaction)); setTxLoading(false); }
      });
    } else {
      setTransactions([]);
    }
    return () => { isMounted = false; };
  }, [session?.user?.id, inGuest, dbReady]);

  const reloadData = async () => {
    const owner = session?.user.id ?? null;
    const stored = owner ? await getTransactions(owner) : await getGuestTransactions();
    setTransactions(stored.map(toUiTransaction));
    setCatViews(await listCategories(getServiceDb(), owner));
    setDataTick((n) => n + 1);
    // Also covers changes that arrived by sync, e.g. resolved on another device.
    void runReviewPass(getServiceDb(), owner).catch(() => undefined);
  };

  // Tapping a review notification. Links are held until the database and session are ready (cold start).
  useEffect(() => { setReviewNotifierPort(getNativeReviewNotifier()); }, []);
  const handleReviewLink = useRef<(link: ReviewLink) => void>(() => undefined);
  handleReviewLink.current = (link) => {
    if (link.kind === 'queue') { setShowReview(true); return; }
    void resolveReviewTarget(getServiceDb(), scope, link.id).then((target) => {
      if (target.status === 'missing') { cancelReviewNotification(link.id); showToast('This transaction is no longer available.', 'info', 'review-missing'); return; }
      if (target.status === 'resolved') showToast('This transaction is already complete.', 'info', 'review-resolved');
      setReviewTxId(link.id);
    }).catch(() => undefined);
  };
  const reviewRouter = useRef(createReviewLinkRouter((link) => handleReviewLink.current(link))).current;
  useEffect(() => {
    void Linking.getInitialURL().then((url) => reviewRouter.receive(url)).catch(() => undefined);
    const sub = Linking.addEventListener('url', (event) => reviewRouter.receive(event.url));
    return () => sub.remove();
  }, [reviewRouter]);
  useEffect(() => { reviewRouter.setReady(authReady && dbReady && (!!session || inGuest)); }, [reviewRouter, authReady, dbReady, session, inGuest]);
  useEffect(() => {
    if (!dbReady) return;
    let live = true;
    listCategories(getServiceDb(), scope).then((c) => { if (live) setCatViews(c); }).catch(() => undefined);
    return () => { live = false; };
  }, [dbReady, scope, dataTick]);

  // Home money summary, derived from the saved SQLite records of the current scope (never from UI state).
  // Re-runs after every add/edit/delete/sync, because each of those replaces `transactions` or bumps `dataTick`.
  useEffect(() => {
    if (!dbReady) return;
    let live = true;
    let db;
    try { db = getServiceDb(); } catch { return; }
    getCashFlowSummary(db, scope).then((s) => { if (live) setCashFlow(s); }).catch(() => undefined);
    getLedgerHealth(db, scope).then((h) => { if (live) setLedgerHealth(h); }).catch(() => undefined);
    return () => { live = false; };
  }, [dbReady, scope, transactions, dataTick]);

  // A session restored while offline may hold an expired access token: retry the refresh when the app is active.
  useEffect(() => {
    if (!session || !sessionStale) return;
    let cancelled = false;
    const retry = async () => {
      try {
        const next = await refreshSession(session);
        if (!cancelled) { setSession(next); setSessionStale(false); }
      } catch (err) {
        const status = (err as { status?: number })?.status;
        if (!cancelled && (status === 400 || status === 401 || status === 403 || status === 422)) {
          await clearSession(); setSession(null); setSessionStale(false);
          endSessionToSignIn();
        }
      }
    };
    void retry();
    const sub = AppState.addEventListener('change', (state) => { if (state === 'active') void retry(); });
    return () => { cancelled = true; sub.remove(); };
  }, [session, sessionStale]);

  // The sync engine watches the network itself (NetInfo): when connectivity returns it runs a cycle without the person doing anything.
  // It asks for the CURRENT session each time, so a refreshed token is used and a signed-out app syncs nothing.
  const latestSession = useRef<Session | null>(null);
  latestSession.current = session;
  useEffect(() => {
    if (!session?.user.id) return;
    void startSyncEngine(async () => latestSession.current).catch(() => undefined);
    return () => stopSyncEngine();
  }, [session?.user.id]);

  useEffect(() => {
    if (!session) return;
    const run = () => { void syncPendingTransactions(session).then(() => reloadData()).catch(() => undefined); };
    run();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') run();
    });
    return () => subscription.remove();
  }, [session]);

  // Durable SMS pipeline: the native receiver stages every bank SMS (even when the app is closed); here we drain the
  // events for the current scope — the signed-in account's own events, or guest-scope events in guest mode — and refresh
  // the dashboard immediately. Signed-in transactions are queued for sync by the service; guest ones stay on the device.
  useEffect(() => {
    configureSupportedSenderPatterns(smsRules.map((rule) => rule.senderPattern));
    if (!dbReady || (!session && !inGuest)) return;
    let active = true;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const drain = async (returnedToApp = false) => {
      try {
        const summary = await drainNativeStagedSms(session, smsRules);
        // A background task may have saved payments while the app was away, so coming back always refreshes.
        if (active && summary && (summary.saved > 0 || summary.duplicates > 0) || (active && returnedToApp)) await reloadData();
        if (active && summary && summary.processed > 0) {
          if (settleTimer) clearTimeout(settleTimer);
          settleTimer = setTimeout(() => { void reloadData().catch(() => undefined); }, REVIEW_SETTLE_MS + 500); // lets the second source arrive first
        }
        if (active && summary && summary.saved > 0) {
          if (active) showToast(`${summary.saved} bank transaction${summary.saved === 1 ? '' : 's'} detected`, 'success', 'sms-detected');
        }
      } catch {
        console.warn('Staged SMS drain failed; events remain staged for retry');
      } finally {
        if (active) setSmsStatusTick((n) => n + 1);
      }
    };
    // Signed in: stamp new SMS with this account. Guest: clear the stamp so new SMS belong to the guest scope.
    const stamped = session ? recordSmsOwner(session.user.id) : clearSmsOwner();
    void stamped.then(() => drain(), () => drain());
    const staged = addSmsStagedListener(() => { void drain(); });
    const appState = AppState.addEventListener('change', (state) => { if (state === 'active') void drain(true); });
    return () => { active = false; if (settleTimer) clearTimeout(settleTimer); staged?.remove(); appState.remove(); };
  }, [session, inGuest, dbReady]); // eslint-disable-line react-hooks/exhaustive-deps

  const submitAuth = async (screen: 'signup' | 'signin') => {
    const normalizedEmail = email.trim().toLowerCase();
    const error = !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) ? 'Enter a valid email address.' : screen === 'signup' && (!fullName.trim() || password.length < 8 || !/[A-Z]/.test(password) || !/\d/.test(password) || password !== confirmPassword || !termsAccepted) ? 'Complete the sign-up fields, password requirements, and terms.' : screen === 'signin' && !password ? 'Enter your password.' : '';
    if (error) { setAuthError(error); return; }
    setAuthBusy(true); setAuthError('');
    try { const next = screen === 'signup' ? await register(fullName.trim(), normalizedEmail, password) : await login(normalizedEmail, password); await saveSession(next);
      // Guest data is never attached silently: ask first, and only if there is something to import.
      const guest = await getGuestDataSummary().catch(() => ({ transactionCount: 0, budgetCount: 0, categoryCount: 0, expectedCount: 0 }));
      setSession(next); setSessionStale(false); setShowAuth(false); setPassword(''); setConfirmPassword('');
      setGuestMode(false); void setGuestModeChosen(false).catch(() => undefined); // an account session replaces the guest choice
      if (guest.transactionCount + guest.budgetCount + guest.categoryCount + guest.expectedCount > 0) setImportPrompt({ count: guest.transactionCount }); } catch (caught) { setAuthError(caught instanceof Error ? caught.message : 'Authentication failed. Try again.'); } finally { setAuthBusy(false); }
  };
  const submitForgot = async () => { setAuthBusy(true); setAuthError(''); try { await requestPasswordReset(email.trim().toLowerCase()); setAuthNotice('Password reset delivery is not configured in this environment.'); } catch (caught) { setAuthError(caught instanceof Error ? caught.message : 'Password reset is unavailable.'); } finally { setAuthBusy(false); } };

  /** Category names offered for a type (the form only ever shows and saves categories of the selected type). */
  const categoriesFor = (dir: Direction): string[] => {
    const names = catViews.filter((c) => c.type === dir).map((c) => c.name);
    return names.length ? names : dir === 'income' ? DEFAULT_INCOME_CATEGORIES : DEFAULT_CATEGORIES;
  };
  const formCategories = categoriesFor(direction);
  /** Every entry point opens the form through here, so the type is always explicit and never left over from last time. */
  const openForm = (dir: Direction) => {
    setDirection(dir);
    setCategory(categoriesFor(dir)[0]);
    setAmount(''); setCounterparty(''); setFormError('');
    setTxDate(localYmd()); setTxTime(localHm()); setDateTouched(false); setTimeTouched(false);
    setShowForm(true);
  };
  const chooseDirection = (dir: Direction) => {
    setDirection(dir); setFormError('');
    const list = categoriesFor(dir);
    if (!list.some((n) => n.toLowerCase() === category.toLowerCase())) setCategory(list[0]);
  };
  const closeForm = () => { Keyboard.dismiss(); setShowForm(false); };

  const addTransaction = async () => {
    if (savingRef.current) return;
    const typed = amount.replace(/,/g, '').trim();
    const value = Number(typed);
    if (!/^\d*\.?\d*$/.test(typed) || !typed || !Number.isFinite(value) || value <= 0) { setFormError('Enter an amount greater than zero.'); return; }
    if (!/^\d*(\.\d{0,2})?$/.test(typed)) { setFormError('Use at most two decimal places.'); return; }
    if (!counterparty.trim()) { setFormError(direction === 'income' ? 'Enter who paid you.' : 'Enter who you paid.'); return; }
    // The saved category must belong to the selected type; fall back to that type's first category.
    const savedCategory = formCategories.find((n) => n.toLowerCase() === category.toLowerCase()) ?? formCategories[0];
    const savedDirection: Direction = direction; // captured once: exactly what the toggle shows
    // Untouched date/time → stamped "now" by the repository, exactly as before. A chosen date/time is combined in device-local time.
    const picked = dateTouched || timeTouched;
    const when = picked ? parseLocalDateTime(txDate, timeTouched ? txTime : localHm()) : null;
    if (picked && !when) { setFormError('Select a valid date and time.'); return; }
    setFormError('');
    savingRef.current = true; setSaving(true);
    try {
      const created = await recordAddTransaction({
        amount: value,
        direction: savedDirection,
        counterparty: counterparty.trim(),
        category: savedCategory,
        description: savedDirection === 'income' ? `Received from ${counterparty.trim()}` : `Paid to ${counterparty.trim()}`,
        source: 'manual',
        ...(when ? { transaction_date: when } : {}),
      }, session);
      notices.localSave(savedDirection, !!session);
      // A payment from/to someone with a pending expected amount: exact matches settle automatically; otherwise ask.
      try {
        const open = (await findOpenForPerson(getServiceDb(), scope, created.counterparty, created.direction === 'income' ? 'receive' : 'pay')).filter((e) => !e.payments.some((p) => p.transaction_id === created.id));
        const target = open.find((e) => outstandingPaise(e) >= created.amount_paise) ?? open[0];
        if (target) {
          const apply = Math.min(created.amount_paise, outstandingPaise(target));
          Alert.alert('Apply to expected payment?', `${target.person} was expected to ${target.direction === 'receive' ? 'pay you' : 'be paid'} ${money(outstandingPaise(target) / 100)}${target.note ? ` (${target.note})` : ''}. Count ${money(apply / 100)} of this transaction towards it?`, [
            { text: 'Not now', style: 'cancel' },
            { text: 'Apply', onPress: () => { void recordPayment(getServiceDb(), scope, target.id, { amountPaise: apply, transactionId: created.id }).then(() => { setDataTick((n) => n + 1); if (session) void syncPendingTransactions(session); }).catch(() => undefined); } },
          ]);
        }
      } catch { /* the prompt is a convenience; the transaction is already saved */ }
      const uiRecord = toUiTransaction(created);
      setTransactions((current) => [uiRecord, ...current.filter((item) => item.id !== uiRecord.id)]);
      setDataTick((n) => n + 1); // refresh analytics, budgets and the cash-flow summary
      setAmount('');
      setCounterparty('');
      closeForm();
    } catch (err) {
      console.error('Failed to record transaction in local SQLite database:', err);
      setFormError('Could not save the transaction. Nothing was recorded; please try again.');
    } finally {
      savingRef.current = false; setSaving(false);
    }
  };

  const continueAsGuest = async () => {
    try { await setGuestModeChosen(true); } catch { /* guest mode still works for this run */ }
    setGuestMode(true); setShowAuth(false);
  };
  const confirmImport = async () => {
    if (!session) return;
    setImportBusy(true);
    try {
      const result = await importGuestData(session.user.id);
      setImportNotice(`Imported ${result.imported} transaction${result.imported === 1 ? '' : 's'}${result.skippedDuplicates ? ` (${result.skippedDuplicates} duplicate${result.skippedDuplicates === 1 ? '' : 's'} skipped)` : ''}. They will sync when online.`);
      await reloadData();
      void syncPendingTransactions(session);
    } catch { setImportNotice('Import failed. Nothing was changed; your local data is intact.'); }
    finally { setImportBusy(false); setImportPrompt(null); }
  };
  const openAuth = (screen: 'signin' | 'signup') => { setAuthScreen(screen); setShowAuth(true); };

  if (!authReady || !dbReady) return <AuthLoading colors={colors} />;
  if (!session && !inGuest) return <AuthScreens onGuest={continueAsGuest} screen={authScreen} setScreen={setAuthScreen} fullName={fullName} setFullName={setFullName} email={email} setEmail={setEmail} password={password} setPassword={setPassword} confirmPassword={confirmPassword} setConfirmPassword={setConfirmPassword} showPassword={showPassword} setShowPassword={setShowPassword} termsAccepted={termsAccepted} setTermsAccepted={setTermsAccepted} busy={authBusy} error={authError} notice={authNotice} onSubmit={submitAuth} onForgot={submitForgot} colors={colors} />;

  return <SafeAreaView style={[styles.safe, { backgroundColor: colors.canvas }]}><StatusBar style={dark ? 'light' : 'dark'} /><View style={styles.shell}>
    <ScrollView contentContainerStyle={[styles.content, narrow && { padding: 16, paddingBottom: 150 }]} keyboardShouldPersistTaps="handled">
      {tab === 'home' ? <HomeHeader greeting={`${greeting}${session ? `, ${session.user.full_name.split(' ')[0]}` : ''}`} initial={session ? session.user.full_name.charAt(0).toUpperCase() : 'G'} reviewCount={ledgerHealth.needsReviewCount} colors={colors} onProfile={() => changeTab('profile')} onSearch={() => changeTab('transactions')} onNotifications={() => setShowReview(true)} />
      : <View style={styles.header}><View><Text style={[styles.overline, { color: palette.accentText }]}>VELNORA</Text><Text style={[styles.title, { color: colors.text }]}>{tab.charAt(0).toUpperCase() + tab.slice(1)}</Text></View><Pressable style={[styles.iconButton, { backgroundColor: colors.card, borderColor: colors.border }]} onPress={() => changeTab('profile')}><Text style={[styles.avatarText, { color: colors.text }]}>{session ? session.user.full_name.charAt(0).toUpperCase() : 'G'}</Text></Pressable></View>}
      {!session && <Text style={[styles.caption, { color: colors.muted, marginBottom: 12 }]}>Guest mode · data stays on this device and is not synced.</Text>}
      {importNotice ? <Text style={styles.noticeText}>{importNotice}</Text> : null}
      {session && sessionStale ? <Text style={[styles.caption, { color: colors.muted, marginBottom: 12 }]}>Offline · working from local data; sync resumes when you reconnect.</Text> : null}
      <Animated.View style={{ opacity: enter, transform: [{ translateX: enter.interpolate({ inputRange: [0, 1], outputRange: [slideDir.current * 28, 0] }) }] }}>
      {tab === 'home' && <HomeScreen scope={scope} onOpen={setOpenTx} transactions={transactions} cashFlow={cashFlow} health={ledgerHealth} onReview={() => setShowReview(true)} colors={colors} onAddIncome={() => openForm('income')} onAddExpense={() => openForm('expense')} onViewAll={() => changeTab('transactions')} onAnalytics={() => changeTab('analytics')} />}
      {tab === 'transactions' && <TransactionsView key={drillCategory ?? 'all'} transactions={transactions} categories={catViews} colors={colors} loading={txLoading} online={online} onOpen={setOpenTx} onAdd={() => openForm('expense')} initialCategory={drillCategory} />}
      {tab === 'analytics' && <AnalyticsView scope={scope} colors={colors} refreshKey={dataTick} onDrill={(c) => { setDrillCategory(c); changeTab('transactions'); }} />}
      {tab === 'budgets' && <BudgetsView scope={scope} categories={catViews} colors={colors} refreshKey={dataTick} />}
            {tab === 'people' && <PeopleView transactions={transactions} categories={catViews} session={session} colors={colors} refreshKey={dataTick} onOpenTx={setOpenTx} onChanged={() => void reloadData()} onAddTransaction={() => openForm('expense')} />}
      {tab === 'profile' && <ProfileView session={session} colors={colors} mode={mode} accent={accent} transactions={transactions} online={online} onOpenSettings={() => setShowSettings(true)} onOpenCurrency={() => setShowCurrency(true)} currencyLabel={(() => { const c = CURRENCIES.find((x) => x.code === currency); return c ? `${c.name} (${c.symbol.trim()})` : currency; })()}
        onOpenCategories={() => setShowCats(true)} onOpenAliases={() => setShowAliases(true)} reviewCount={ledgerHealth.needsReviewCount} onOpenReview={() => setShowReview(true)} onOpenAccounts={() => setShowAccounts(true)} onOpenImport={() => setShowImport('csv')} onOpenImportPdf={() => setShowImport('pdf')} onSignIn={() => openAuth('signin')} onCreate={() => openAuth('signup')}
        onLogout={async () => { if (!session) return; await clearReviewNotifications(getServiceDb(), session.user.id).catch(() => undefined); await logout(session); setSession(null); setSessionStale(false); setTransactions([]); setAuthScreen('welcome'); setShowAuth(true); }}
        accountSections={session ? <><LocalDataSection userId={session.user.id} colors={colors} onDeleted={() => { setTransactions([]); setSmsStatusTick((n) => n + 1); }} /><SmsStagingStatusSection userId={session.user.id} colors={colors} refreshKey={smsStatusTick} /></> : null} />}
      </Animated.View>
    </ScrollView>
    {tab !== 'profile' && <Pressable style={({ pressed }) => [styles.fab, pressed && { opacity: 0.9, transform: [{ scale: 0.97 }] }]} onPress={() => openForm('expense')} accessibilityRole="button" accessibilityLabel="Add transaction"><Plus color="#FFFFFF" size={26} strokeWidth={2} /></Pressable>}
    <ToastHost bottom={layout.navHeight + 76} />
    <BottomNav tab={tab} setTab={changeTab} colors={colors} dark={dark} />
  </View>
  <Modal visible={importPrompt !== null} transparent animationType="fade" onRequestClose={() => setImportPrompt(null)}><View style={styles.modalBackdrop}><View style={[styles.modal, { backgroundColor: colors.card }]}>
    <Text style={[styles.modalTitle, { color: colors.text }]}>Import local data?</Text>
    <Text style={[styles.caption, { color: colors.muted, marginVertical: 12 }]}>{importPrompt?.count ?? 0} transaction{importPrompt?.count === 1 ? '' : 's'} recorded without an account exist on this device. Importing associates them with {session?.user.email ?? 'this account'} and uploads them to sync. If you cancel, they stay on this device, separate from your account, and nothing is uploaded.</Text>
    <Pressable disabled={importBusy} style={styles.primaryButton} onPress={() => void confirmImport()}><Text style={styles.primaryButtonText}>{importBusy ? 'Importing...' : 'Import and sync'}</Text></Pressable>
    <Pressable disabled={importBusy} onPress={() => setImportPrompt(null)}><Text style={[styles.link, { textAlign: 'center', marginTop: 16 }]}>Not now</Text></Pressable>
  </View></View></Modal>
  <ReviewSheet visible={showReview} session={session} colors={colors} onClose={() => setShowReview(false)} onComplete={setReviewTxId} />
  <CompleteTransactionSheet transactionId={reviewTxId} session={session} categories={catViews} colors={colors} onClose={() => setReviewTxId(null)} onChanged={() => void reloadData()} onEdit={setOpenTx} />
  <AccountsSheet visible={showAccounts} scope={scope} colors={colors} onClose={() => setShowAccounts(false)} onChanged={() => void reloadData()} />
  <StatementImportSheet visible={showImport !== null} mode={showImport ?? 'csv'} scope={scope} session={session} categories={catViews} refreshSession={(stale) => sessionRefresher.current?.(stale) ?? Promise.resolve(null)} colors={colors} onClose={() => setShowImport(null)} onImported={() => { void reloadData(); if (session) void syncPendingTransactions(session); }} />
  <Sheet visible={showForm} onClose={closeForm} title="Record transaction" colors={colors} footer={<>
    {formError ? <Text style={[styles.errorText, { marginTop: 0, marginBottom: 8 }]} accessibilityLiveRegion="polite">{formError}</Text> : null}
    <Pressable disabled={saving} onPress={() => void addTransaction()} accessibilityRole="button" accessibilityState={{ disabled: saving, busy: saving }}
      style={({ pressed }) => [styles.primaryButton, { marginTop: 0, opacity: saving ? 0.6 : pressed ? 0.85 : 1 }]}>
      <Text style={[styles.primaryButtonText, { color: readableOn(palette.accentText) }]}>{saving ? 'Saving…' : direction === 'income' ? 'Save income' : 'Save expense'}</Text>
    </Pressable>
  </>}>
    <Text style={[styles.label, { color: colors.muted, marginTop: 0 }]}>TYPE</Text>
    <TypeToggle value={direction} onChange={chooseDirection} colors={colors} />
    <Text style={[styles.label, { color: colors.muted }]}>AMOUNT</Text>
    <View style={[styles.amountBox, { backgroundColor: colors.card, borderColor: amountFocused ? palette.emerald : colors.border, borderWidth: amountFocused ? 1.5 : 1 }]}>
      <Text style={[styles.amountSymbol, { color: direction === 'income' ? palette.accentText : palette.expenseText }]}>{currencySymbol()}</Text>
      <TextInput value={amount} onChangeText={(t) => { setAmount(t); if (formError) setFormError(''); }} keyboardType="decimal-pad" returnKeyType="done" onSubmitEditing={() => Keyboard.dismiss()}
        onFocus={() => setAmountFocused(true)} onBlur={() => setAmountFocused(false)} placeholder="0.00" placeholderTextColor={colors.muted} accessibilityLabel="Amount"
        style={[styles.amountInput, { color: colors.text }]} />
    </View>
    <Text style={[styles.label, { color: colors.muted }]}>{direction === 'income' ? 'RECEIVED FROM' : 'MERCHANT OR COUNTERPARTY'}</Text>
    <Input colors={colors} value={counterparty} onChangeText={(t) => { setCounterparty(t); if (formError) setFormError(''); }} placeholder={direction === 'income' ? 'e.g. Employer, client, friend' : 'e.g. Grocery store'}
      returnKeyType="done" autoCapitalize="words" onSubmitEditing={() => Keyboard.dismiss()} accessibilityLabel="Merchant or counterparty" />
    <View style={{ flexDirection: 'row', gap: 10 }}>
      <View style={{ flex: 1 }}><Text style={[styles.label, { color: colors.muted }]}>DATE</Text><DateField value={txDate} colors={colors} title="Transaction date" accessibilityLabel="Transaction date" onChange={(v) => { setTxDate(v); setDateTouched(true); if (formError) setFormError(''); }} /></View>
      <View style={{ flex: 1 }}><Text style={[styles.label, { color: colors.muted }]}>TIME</Text><TimeField value={txTime} colors={colors} title="Transaction time" accessibilityLabel="Transaction time" onChange={(v) => { setTxTime(v); setTimeTouched(true); }} /></View>
    </View>
    <Text style={[styles.label, { color: colors.muted }]}>CATEGORY</Text>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingRight: 8 }}>
      {formCategories.map((item) => <Chip key={item} label={item} active={category.toLowerCase() === item.toLowerCase()} color={catViews.find((c) => c.type === direction && c.name === item)?.color} onPress={() => setCategory(item)} colors={colors} />)}
    </ScrollView>
    <Pressable onPress={() => { closeForm(); setShowScan(true); }} accessibilityRole="button" style={({ pressed }) => [styles.scanLink, { borderColor: colors.border, opacity: pressed ? 0.7 : 1 }]}>
      <ScanLine color={palette.emerald} size={18} /><Text style={styles.link}>Scan a receipt instead</Text>
    </Pressable>
  </Sheet>
  <TransactionSheet tx={openTx} session={session} categories={catViews} colors={colors} onClose={() => setOpenTx(null)} onChanged={() => void reloadData()} />
  <ReceiptScan visible={showScan} session={session} categories={catViews} colors={colors} onClose={() => setShowScan(false)} onSaved={() => void reloadData()} />
  <SettingsPage visible={showSettings} onClose={() => setShowSettings(false)} colors={colors} mode={mode} setMode={setMode} accent={accent} setAccent={setAccent} />
  <CurrencySheet visible={showCurrency} onClose={() => setShowCurrency(false)} colors={colors} code={currency} setCode={setCurrency} />
  <CategoryManager visible={showCats} scope={scope} colors={colors} onClose={() => setShowCats(false)} onChanged={() => void reloadData()} />
  <MerchantNamesManager visible={showAliases} userId={scope} colors={colors} onClose={() => setShowAliases(false)} />
  </SafeAreaView>;
}

function HomeScreen({ scope, onOpen, transactions, cashFlow, health, onReview, colors, onAddIncome, onAddExpense, onViewAll, onAnalytics }: { scope: string | null; onOpen: (tx: TransactionEntity) => void; transactions: Transaction[]; cashFlow: CashFlowSummary; health: LedgerHealth; onReview: () => void; colors: Colors; onAddIncome: () => void; onAddExpense: () => void; onViewAll: () => void; onAnalytics: () => void }) {
  const { monthIncomePaise: income, monthExpensePaise: expense, balancePaise: balance } = cashFlow;
  return <>
    <View style={styles.heroCard}>
      <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" pointerEvents="none">
        <Defs><LinearGradient id="heroGrad" x1="0" y1="0" x2="1" y2="1"><Stop offset="0" stopColor={palette.heroStart} /><Stop offset="1" stopColor={palette.heroEnd} /></LinearGradient></Defs>
        <Path d="M0 0H2000V2000H0Z" fill="url(#heroGrad)" />
        <Circle cx="92%" cy="8%" r="90" fill="#FFFFFF" fillOpacity={0.06} />
        <Circle cx="104%" cy="70%" r="60" fill="#FFFFFF" fillOpacity={0.05} />
      </Svg>
      <Text style={styles.heroLabel}>RECORDED BALANCE</Text>
      <Text style={[styles.heroValue, balance < 0 && { color: palette.expenseOnNavy }]} numberOfLines={1} adjustsFontSizeToFit>{formatMinor(balance)}</Text>
      <Text style={styles.heroHint}>Based on transactions recorded in Velnora. Not a verified bank balance.</Text>
    </View>
    <View style={styles.flowRow}>
      <FlowCard label="Income this month" value={formatMinor(income)} color={palette.accentText} icon={<ArrowDownLeft color={palette.accentText} size={16} strokeWidth={2} />} colors={colors} />
      <FlowCard label="Expenses this month" value={formatMinor(expense)} color={palette.expenseText} icon={<ArrowUpRight color={palette.expenseText} size={16} strokeWidth={2} />} colors={colors} />
    </View>
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, marginTop: 14 }]}>
      <Text style={[styles.cardTitle, { color: colors.text }]}>Today</Text>
      <Text style={[styles.caption, { color: colors.muted, marginTop: 4 }]}>In {formatMinor(health.todayIncomePaise)} · Out {formatMinor(health.todayExpensePaise)} · Net {formatMinor(health.todayNetPaise)}</Text>
      <Text style={[styles.caption, { color: colors.muted, marginTop: 4 }]}>{health.totalCount} transactions: {health.verifiedCount} verified, {health.detectedCount} detected, {health.needsReviewCount} to review</Text>
      {health.monthUnverifiedExpensePaise > 0 ? <Text style={[styles.caption, { color: colors.muted, marginTop: 4 }]}>{formatMinor(health.monthUnverifiedExpensePaise)} of this month's spending is detected and not yet confirmed.</Text> : null}
      {health.needsReviewCount > 0 ? <Pressable onPress={onReview} accessibilityRole="button" style={{ minHeight: 44, justifyContent: 'center' }}><Text style={[styles.link, { color: palette.accentText }]}>Review {health.needsReviewCount} transaction{health.needsReviewCount === 1 ? '' : 's'}</Text></Pressable> : null}
    </View>
    <SectionHeader title="Quick actions" colors={colors} />
    <View style={styles.actionRow}>
      <ActionButton icon={<ArrowDownLeft color={palette.emerald} size={20} strokeWidth={2} />} tint={palette.emerald} label="Add income" hint="Salary, refunds" onPress={onAddIncome} colors={colors} />
      <ActionButton icon={<ArrowUpRight color={palette.danger} size={20} strokeWidth={2} />} tint={palette.danger} label="Add expense" hint="Bills, shopping" onPress={onAddExpense} colors={colors} />
    </View>
    <SectionHeader title="Spending overview" action="Analytics" onPress={onAnalytics} colors={colors} />
    <SpendingOverview scope={scope} refreshKey={transactions} colors={colors} transactions={transactions}
      renderTransaction={(id) => { const item = transactions.find((t) => t.id === id); return item ? <Pressable onPress={() => onOpen(item)} accessibilityRole="button"><TransactionRow item={item} colors={colors} /></Pressable> : null; }} />
    <SectionHeader title="Recent transactions" action="See all" onPress={onViewAll} colors={colors} />
    {transactions.length ? <View style={[styles.listCard, { backgroundColor: colors.card, borderColor: colors.border }]}>{transactions.slice(0, 5).map((item, i, arr) => <Pressable key={item.id} onPress={() => onOpen(item)} accessibilityRole="button" android_ripple={{ color: tint(palette.emerald, 0.1) }}><TransactionRow item={item} colors={colors} last={i === arr.length - 1} /></Pressable>)}</View> : <EmptyState colors={colors} onAdd={onAddExpense} />}
  </>;
}

function TransactionsScreen({ transactions, categories = DEFAULT_CATEGORIES, colors, onAdd }: { transactions: Transaction[]; categories?: string[]; colors: Colors; onAdd: () => void }) {
  const [query, setQuery] = useState(''); const [filter, setFilter] = useState<'all' | Direction>('all'); const [categoryFilter, setCategoryFilter] = useState('All categories');
  const filtered = transactions.filter((item) => (filter === 'all' || item.direction === filter) && (categoryFilter === 'All categories' || item.category === categoryFilter) && `${item.counterparty} ${item.category}`.toLowerCase().includes(query.toLowerCase()));
  return <><View style={[styles.searchBox, { backgroundColor: colors.card, borderColor: colors.border }]}><Search color={colors.muted} size={18} /><TextInput value={query} onChangeText={setQuery} placeholder="Search transactions" placeholderTextColor={colors.muted} style={[styles.searchInput, { color: colors.text }]} /></View><View style={styles.filterRow}>{(['all', 'income', 'expense'] as const).map((item) => <Pressable key={item} onPress={() => setFilter(item)} style={[styles.filterChip, filter === item && styles.filterChipActive]}><Text style={[styles.filterChipText, { color: filter === item ? palette.navy : colors.muted }]}>{item === 'all' ? 'All' : item === 'income' ? 'Income' : 'Expenses'}</Text></Pressable>)}</View><ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.categoryScroll}>{['All categories', ...new Set(categories)].map((item) => <Pressable key={item} onPress={() => setCategoryFilter(item)} style={[styles.chip, categoryFilter === item && styles.chipActive]}><Text style={[styles.chipText, { color: categoryFilter === item ? palette.navy : colors.muted }]}>{item}</Text></Pressable>)}</ScrollView><SectionHeader title={`${filtered.length} transactions`} action="Add" onPress={onAdd} colors={colors} />{filtered.length ? filtered.map((item) => <TransactionRow key={item.id} item={item} colors={colors} />) : <EmptyState colors={colors} onAdd={onAdd} />}</>;
}

function AnalyticsScreen({ transactions, categories = DEFAULT_CATEGORIES, totals, colors }: { transactions: Transaction[]; categories?: string[]; totals: { income: number; expense: number }; colors: Colors }) {
  const categoryTotals = categories.map((name) => ({ name, value: transactions.filter((item) => item.category === name && item.direction === 'expense').reduce((sum, item) => sum + item.amount, 0) })).filter((item) => item.value > 0);
  const max = Math.max(1, ...categoryTotals.map((item) => item.value));
  return <><View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}><Text style={[styles.cardTitle, { color: colors.text }]}>Income vs expenses</Text><View style={styles.chart}><View style={[styles.chartBar, { height: Math.max(12, Math.min(140, totals.income / 10)), backgroundColor: palette.emerald }]} /><View style={[styles.chartBar, { height: Math.max(12, Math.min(140, totals.expense / 10)), backgroundColor: palette.danger }]} /></View><View style={styles.legend}><Text style={[styles.caption, { color: colors.muted }]}>Income {money(totals.income)}</Text><Text style={[styles.caption, { color: colors.muted }]}>Expenses {money(totals.expense)}</Text></View></View><SectionHeader title="Category spending" colors={colors} />{categoryTotals.length ? categoryTotals.map((item) => <View key={item.name} style={styles.budgetRow}><View style={styles.rowBody}><Text style={[styles.rowTitle, { color: colors.text }]}>{item.name}</Text><View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${item.value / max * 100}%`, backgroundColor: palette.emerald }]} /></View></View><Text style={[styles.rowAmount, { color: colors.text }]}>{money(item.value)}</Text></View>) : <EmptyState colors={colors} onAdd={() => {}} />}</>;
}

function BudgetsScreen({ colors, onAdd }: { colors: Colors; onAdd: () => void }) { return <><View style={[styles.card, { backgroundColor: palette.navy, borderColor: palette.navy }]}><Target color={palette.emerald} size={28} /><Text style={styles.heroTitle}>Plan your month with intention</Text><Text style={styles.heroHint}>Create category budgets and savings goals from your real spending.</Text><Pressable style={styles.outlineButton} onPress={onAdd}><Text style={styles.outlineButtonText}>Create a budget</Text></Pressable></View><SectionHeader title="Budget utilization" colors={colors} /><View style={[styles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}><PiggyBank color={palette.emerald} size={28} /><Text style={[styles.emptyTitle, { color: colors.text }]}>No budgets yet</Text><Text style={[styles.caption, { color: colors.muted }]}>Your budget progress will appear here after you set a monthly allocation.</Text></View><SectionHeader title="Savings goals" colors={colors} /><View style={[styles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}><Text style={[styles.emptyTitle, { color: colors.text }]}>No savings goals yet</Text><Text style={[styles.caption, { color: colors.muted }]}>Set a goal to make your next milestone visible.</Text></View></>; }

function PeopleScreen({ contacts, colors, onAdd }: { contacts: Contact[]; colors: Colors; onAdd: () => void }) { return <><Text style={[styles.subtitle, { color: colors.muted }]}>Track money received, money paid, and your recorded history with each person.</Text>{contacts.length ? contacts.map((contact) => <View key={contact.name} style={[styles.personRow, { borderBottomColor: colors.border }]}><View style={styles.personAvatar}><Text style={styles.personInitial}>{contact.name.charAt(0).toUpperCase()}</Text></View><View style={styles.rowBody}><Text style={[styles.rowTitle, { color: colors.text }]}>{contact.name}</Text><Text style={[styles.caption, { color: colors.muted }]}>{contact.count} transaction{contact.count === 1 ? '' : 's'} · Received {money(contact.received)}</Text></View><Text style={[styles.rowAmount, { color: palette.expenseText }]}>{money(contact.paid)}</Text></View>) : <EmptyState colors={colors} onAdd={onAdd} />}</>; }


type Colors = { canvas: string; card: string; border: string; text: string; muted: string };
function SettingRow({ icon, title, value, colors, onPress }: { icon: React.ReactNode; title: string; value: string; colors: Colors; onPress?: () => void }) { return <Pressable disabled={!onPress} onPress={onPress} accessibilityRole={onPress ? 'button' : undefined} style={[styles.settingRow, { borderBottomColor: colors.border }]}><View style={styles.settingIcon}>{icon}</View><View style={styles.rowBody}><Text style={[styles.rowTitle, { color: colors.text }]}>{title}</Text><Text style={[styles.caption, { color: colors.muted }]}>{value}</Text></View><ChevronRight color={colors.muted} size={18} /></Pressable>; }
function Metric({ label, value, color, icon }: { label: string; value: string; color: string; icon: React.ReactNode }) { return <View style={styles.metric}><View style={styles.metricLabelRow}><View style={[styles.metricIcon, { backgroundColor: `${color}26` }]}>{icon}</View><Text style={[styles.heroLabel, styles.metricLabel]}>{label}</Text></View><Text style={[styles.metricValue, { color }]} numberOfLines={1} adjustsFontSizeToFit>{value}</Text></View>; }
function ActionButton({ icon, tint, label, hint, onPress, colors }: { icon: React.ReactNode; tint: string; label: string; hint: string; onPress: () => void; colors: Colors }) {
  return <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} android_ripple={{ color: `${tint}22` }}
    style={({ pressed }) => [styles.actionButton, { backgroundColor: colors.card, borderColor: pressed ? tint : colors.border, transform: [{ scale: pressed ? 0.97 : 1 }] }]}>
    <View style={[styles.actionIcon, { backgroundColor: `${tint}1F` }]}>{icon}</View>
    <View style={styles.rowBody}><Text style={[styles.actionLabel, { color: colors.text }]}>{label}</Text><Text style={[styles.actionHint, { color: colors.muted }]} numberOfLines={1}>{hint}</Text></View>
  </Pressable>;
}
function SectionHeader({ title, action, onPress, colors }: { title: string; action?: string; onPress?: () => void; colors: Colors }) { return <View style={styles.sectionHeader}><Text style={[styles.sectionTitle, { color: colors.text }]}>{title}</Text>{action && <Pressable onPress={onPress}><Text style={styles.link}>{action}</Text></Pressable>}</View>; }
function detectedLabel(via?: string[]): string {
  const sms = via?.includes('sms');
  const tc = via?.includes('truecaller_notification');
  if (sms && tc) return 'SMS + Truecaller detected';
  if (tc) return 'Truecaller detected';
  return 'SMS detected';
}
function TransactionRow({ item, colors, last }: { item: Transaction; colors: Colors; last?: boolean }) { const incoming = item.direction === 'income'; return <View style={[styles.transactionRow, { borderBottomColor: colors.border }, last && { borderBottomWidth: 0 }]}><View style={[styles.transactionIcon, { backgroundColor: incoming ? tint(palette.emerald) : tint(palette.danger) }]}>{incoming ? <ArrowDownLeft color={palette.emerald} size={18} /> : <ArrowUpRight color={palette.danger} size={18} />}</View><View style={styles.rowBody}><Text style={[styles.rowTitle, { color: colors.text }]}>{item.counterparty}</Text><Text style={[styles.caption, { color: colors.muted }]}>{item.category} · {new Date(item.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</Text><Text style={[styles.sourceLabel, { color: item.source === 'sms' ? palette.accentText : colors.muted }]}>{item.source === 'sms' ? detectedLabel(item.detected_via) : 'Manual'}</Text></View><Text style={[styles.rowAmount, { color: incoming ? palette.accentText : palette.expenseText }]}>{incoming ? '+' : '-'}{money(item.amount)}</Text></View>; }
function EmptyState({ colors, onAdd }: { colors: Colors; onAdd: () => void }) { return <View style={[styles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}><WalletCards color={palette.emerald} size={26} /><Text style={[styles.emptyTitle, { color: colors.text }]}>No transactions yet</Text><Text style={[styles.caption, { color: colors.muted }]}>Add your first income or expense to start understanding your cash flow.</Text><Pressable onPress={onAdd}><Text style={styles.link}>Add transaction</Text></Pressable></View>; }
function HomeHeader({ greeting, initial, reviewCount, colors, onProfile, onSearch, onNotifications }: { greeting: string; initial: string; reviewCount: number; colors: Colors; onProfile: () => void; onSearch: () => void; onNotifications: () => void }) {
  const btn = (pressed: boolean) => [styles.headerBtn, { backgroundColor: pressed ? tint(palette.emerald, 0.14) : colors.card, borderColor: colors.border }];
  return <View style={styles.homeHeader}>
    <Pressable onPress={onProfile} accessibilityRole="button" accessibilityLabel="Open profile" hitSlop={4} style={({ pressed }) => [styles.headerAvatar, { backgroundColor: palette.emeraldSoft, opacity: pressed ? 0.8 : 1 }]}><Text style={[styles.avatarText, { color: palette.navy }]}>{initial}</Text></Pressable>
    <View style={styles.headerText}><Text style={[styles.overline, { color: palette.accentText }]}>VELNORA</Text><Text style={[styles.homeGreeting, { color: colors.text }]} numberOfLines={1}>{greeting}</Text></View>
    <Pressable onPress={onSearch} accessibilityRole="button" accessibilityLabel="Search transactions" hitSlop={4} style={({ pressed }) => btn(pressed)}><Search color={colors.text} size={20} strokeWidth={2} /></Pressable>
    <Pressable onPress={onNotifications} accessibilityRole="button" accessibilityLabel={reviewCount > 0 ? `Review queue, ${reviewCount} transaction${reviewCount === 1 ? '' : 's'} to review` : 'Review queue'} hitSlop={4} style={({ pressed }) => btn(pressed)}>
      <Bell color={colors.text} size={20} strokeWidth={2} />
      {reviewCount > 0 ? <View style={styles.badge}><Text style={styles.badgeText}>{reviewCount > 99 ? '99+' : reviewCount}</Text></View> : null}
    </Pressable>
  </View>;
}
function FlowCard({ label, value, color, icon, colors }: { label: string; value: string; color: string; icon: React.ReactNode; colors: Colors }) {
  return <View style={[styles.flowCard, { backgroundColor: colors.card, borderColor: colors.border }]} accessible accessibilityLabel={`${label}: ${value}`}>
    <View style={styles.flowCardHead}><View style={[styles.flowIcon, { backgroundColor: tint(color, 0.12) }]}>{icon}</View><Text style={[styles.flowCardLabel, { color: colors.muted }]} numberOfLines={1}>{label}</Text></View>
    <Text style={[styles.flowCardValue, { color }]} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
  </View>;
}
/** Bottom-navigation tap response: 3 dp up, 1.05x, ~200 ms in total, ease-out, no overshoot. */
const NAV_TAP = { liftDp: 3, scale: 1.05, riseMs: 80, returnMs: 120 } as const;

function NavItem({ Icon, label, active, onPress, colors, dark }: { Icon: typeof Home; label: string; active: boolean; onPress: () => void; colors: Colors; dark: boolean }) {
  const on = useRef(new Animated.Value(active ? 1 : 0)).current;
  // Subtle tap response on the icon only: it eases up ~3 dp and scales to 1.05, then eases back to exactly where it was
  // (timing-based: no spring, no overshoot, no repeat). Plays when this tab becomes active (taps and programmatic tab
  // changes alike) and again when the already-active tab is tapped. Runs on the native driver; other tabs and the bar stay still.
  const pop = useRef(new Animated.Value(0)).current; // 0 = at rest, 1 = peak of the tap response
  const playPop = () => {
    pop.stopAnimation();
    pop.setValue(0);
    Animated.sequence([
      Animated.timing(pop, { toValue: 1, duration: NAV_TAP.riseMs, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(pop, { toValue: 0, duration: NAV_TAP.returnMs, easing: Easing.out(Easing.quad), useNativeDriver: true }),
    ]).start();
  };
  const mounted = useRef(false);
  useEffect(() => {
    Animated.timing(on, { toValue: active ? 1 : 0, duration: 160, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    if (mounted.current && active) playPop();
    mounted.current = true;
  }, [active, on]); // eslint-disable-line react-hooks/exhaustive-deps
  return <Pressable style={styles.navItem} hitSlop={{ top: 4, bottom: 4 }} onPress={() => { if (active) playPop(); onPress(); }} accessibilityRole="tab" accessibilityState={{ selected: active }} accessibilityLabel={label}>
    <View style={styles.navPillWrap}>
      {/* Selected background: a rounded accent pill that grows in behind the active icon. */}
      <Animated.View pointerEvents="none" style={[styles.navPill, { backgroundColor: dark ? `${palette.emerald}38` : palette.emeraldSoft, opacity: on, transform: [{ scaleX: on.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] }) }] }]} />
      <Animated.View pointerEvents="none" style={{ transform: [{ translateY: pop.interpolate({ inputRange: [0, 1], outputRange: [0, -NAV_TAP.liftDp] }) }, { scale: pop.interpolate({ inputRange: [0, 1], outputRange: [1, NAV_TAP.scale] }) }] }}>
        <Icon size={20} color={active ? palette.accentText : colors.muted} strokeWidth={2} />
      </Animated.View>
    </View>
    <Text style={[styles.navLabel, { color: active ? palette.accentText : colors.muted, fontWeight: active ? '600' : '500' }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85}>{label}</Text>
  </Pressable>;
}
function BottomNav({ tab, setTab, colors, dark }: { tab: Tab; setTab: (tab: Tab) => void; colors: Colors; dark: boolean }) {
  const items: [Tab, typeof Home, string][] = [['home', Home, 'Home'], ['transactions', LayoutGrid, 'Transactions'], ['analytics', Chart, 'Analytics'], ['budgets', WalletCards, 'Budgets'], ['people', Users, 'People']];
  return <View accessibilityRole="tablist" style={[styles.nav, { backgroundColor: colors.card, borderTopColor: colors.border }]}>
    {items.map(([key, Icon, label]) => <NavItem key={key} Icon={Icon} label={label} active={tab === key} onPress={() => setTab(key)} colors={colors} dark={dark} />)}
  </View>;
}

function AuthLoading({ colors }: { colors: Colors }) { return <SafeAreaView style={[styles.safe, { backgroundColor: colors.canvas }]}><View style={styles.loading}><Text style={[styles.brand, { color: palette.accentText }]}>VELNORA</Text></View></SafeAreaView>; }
type AuthProps = { onGuest: () => void; screen: 'welcome' | 'signup' | 'signin' | 'forgot'; setScreen: (screen: 'welcome' | 'signup' | 'signin' | 'forgot') => void; fullName: string; setFullName: (value: string) => void; email: string; setEmail: (value: string) => void; password: string; setPassword: (value: string) => void; confirmPassword: string; setConfirmPassword: (value: string) => void; showPassword: boolean; setShowPassword: (value: boolean) => void; termsAccepted: boolean; setTermsAccepted: (value: boolean) => void; busy: boolean; error: string; notice: string; onSubmit: (screen: 'signup' | 'signin') => Promise<void>; onForgot: () => Promise<void>; colors: Colors };
function AuthScreens(props: AuthProps) { const signup = props.screen === 'signup'; const forgot = props.screen === 'forgot'; if (props.screen === 'welcome') return <SafeAreaView style={[styles.safe, { backgroundColor: palette.navy }]}><StatusBar style="light" /><ScrollView contentContainerStyle={styles.welcome}><View style={{ marginBottom: 14 }}><VelnoraLogo size={92} /></View><Text style={styles.brand}>VELNORA</Text><Text style={styles.welcomeTitle}>Take control of your money.</Text><Text style={styles.welcomeDescription}>Track better. Budget smarter. Manage money confidently.</Text><Text style={styles.productDescriptor}>Personal Finance & Expense Tracker</Text><Pressable style={styles.primaryButton} onPress={() => props.setScreen('signup')}><Text style={styles.primaryButtonText}>Get started</Text></Pressable><Pressable style={styles.secondaryButton} onPress={() => props.setScreen('signin')}><Text style={styles.secondaryButtonText}>I already have an account</Text></Pressable><Pressable onPress={props.onGuest}><Text style={[styles.link, { textAlign: 'center', marginTop: 20 }]}>Continue without an account</Text></Pressable></ScrollView></SafeAreaView>; return <SafeAreaView style={[styles.safe, { backgroundColor: props.colors.canvas }]}><StatusBar style={props.colors.canvas === palette.darkCanvas ? 'light' : 'dark'} /><KeyboardAvoidingView style={styles.safe} behavior="padding"><ScrollView contentContainerStyle={[styles.formScreen, { paddingBottom: 160 }]} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"><Pressable onPress={() => props.setScreen(forgot ? 'signin' : 'welcome')}><Text style={styles.link}>‹ Back</Text></Pressable><View style={{ marginTop: 28 }}><VelnoraLogo size={64} /></View><Text style={[styles.brand, { marginTop: 10 }]}>VELNORA</Text><Text style={[styles.authTitle, { color: props.colors.text }]}>{signup ? 'Create your account' : forgot ? 'Reset your password' : 'Welcome back'}</Text><Text style={[styles.subtitle, { color: props.colors.muted }]}>{signup ? 'Start building a clearer view of your finances.' : 'Sign in to continue managing your money.'}</Text>{signup && <AuthField label="FULL NAME" value={props.fullName} onChangeText={props.setFullName} placeholder="Your name" colors={props.colors} icon={<UserRound color={props.colors.muted} size={17} />} />}{<AuthField label="EMAIL" value={props.email} onChangeText={props.setEmail} placeholder="you@example.com" colors={props.colors} icon={<KeyRound color={props.colors.muted} size={17} />} />}{!forgot && <PasswordField label="PASSWORD" value={props.password} onChangeText={props.setPassword} visible={props.showPassword} toggle={() => props.setShowPassword(!props.showPassword)} colors={props.colors} />}{signup && <PasswordField label="CONFIRM PASSWORD" value={props.confirmPassword} onChangeText={props.setConfirmPassword} visible={props.showPassword} toggle={() => props.setShowPassword(!props.showPassword)} colors={props.colors} />}{signup && <Pressable style={styles.termsRow} onPress={() => props.setTermsAccepted(!props.termsAccepted)}><View style={[styles.checkbox, props.termsAccepted && styles.checkboxActive]}>{props.termsAccepted && <Text>✓</Text>}</View><Text style={[styles.caption, { color: props.colors.muted }]}>I accept the terms and privacy policy.</Text></Pressable>}{props.error ? <Text style={styles.errorText}>{props.error}</Text> : null}{props.notice ? <Text style={styles.noticeText}>{props.notice}</Text> : null}<Pressable disabled={props.busy} style={styles.primaryButton} onPress={() => forgot ? props.onForgot() : props.onSubmit(signup ? 'signup' : 'signin')}><Text style={styles.primaryButtonText}>{props.busy ? 'Please wait...' : signup ? 'Create account' : forgot ? 'Check reset options' : 'Sign in'}</Text></Pressable>{!signup && !forgot && <Pressable onPress={() => props.setScreen('forgot')}><Text style={[styles.link, { textAlign: 'center', marginTop: 18 }]}>Forgot password?</Text></Pressable>}{!forgot && <Pressable onPress={() => props.setScreen(signup ? 'signin' : 'signup')}><Text style={[styles.caption, { color: props.colors.muted, textAlign: 'center', marginTop: 22 }]}>{signup ? 'Already have an account? ' : 'New to Velnora? '}<Text style={styles.link}>{signup ? 'Sign in' : 'Create account'}</Text></Text></Pressable>}</ScrollView></KeyboardAvoidingView></SafeAreaView>; }
function AuthField({ label, value, onChangeText, placeholder, icon, colors }: { label: string; value: string; onChangeText: (value: string) => void; placeholder: string; icon: React.ReactNode; colors: Colors }) { return <View style={styles.authField}><Text style={[styles.label, { color: colors.muted }]}>{label}</Text><View style={[styles.authInputWrap, { backgroundColor: colors.card, borderColor: colors.border }]}>{icon}<TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={colors.muted} style={[styles.inputBare, { color: colors.text }]} autoCapitalize="none" /></View></View>; }
function PasswordField({ label, value, onChangeText, visible, toggle, colors }: { label: string; value: string; onChangeText: (value: string) => void; visible: boolean; toggle: () => void; colors: Colors }) { return <View style={styles.authField}><Text style={[styles.label, { color: colors.muted }]}>{label}</Text><View style={[styles.authInputWrap, { backgroundColor: colors.card, borderColor: colors.border }]}><LockKeyhole color={colors.muted} size={17} /><TextInput value={value} onChangeText={onChangeText} placeholder="8+ characters" placeholderTextColor={colors.muted} secureTextEntry={!visible} style={[styles.inputBare, { color: colors.text }]} /><Pressable onPress={toggle}>{visible ? <EyeOff color={colors.muted} size={18} /> : <Eye color={colors.muted} size={18} />}</Pressable></View></View>; }

const buildStyles = () => StyleSheet.create({
  safe: { flex: 1 }, shell: { flex: 1 }, content: { padding: 20, paddingBottom: 150 }, header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }, overline: { ...type.overline }, title: { ...type.display, marginTop: 6 }, iconButton: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', borderWidth: 1 }, avatarText: { ...type.bodyStrong }, heroCard: { borderRadius: radius.xl, padding: 22, marginBottom: 12, overflow: 'hidden', backgroundColor: palette.heroEnd }, flowRow: { flexDirection: 'row', gap: 12 }, flowCard: { flex: 1, minWidth: 0, borderRadius: radius.lg, borderWidth: 1, padding: 14 }, flowCardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 }, flowIcon: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' }, flowCardLabel: { ...type.caption, flex: 1 }, flowCardValue: { ...type.amountMd, marginTop: 10 }, listCard: { borderRadius: radius.lg, borderWidth: 1, paddingHorizontal: 14, overflow: 'hidden' }, homeHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 20 }, headerAvatar: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' }, headerText: { flex: 1, minWidth: 0 }, homeGreeting: { ...type.cardTitle, marginTop: 2 }, headerBtn: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, alignItems: 'center', justifyContent: 'center' }, badge: { position: 'absolute', top: -3, right: -3, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4, backgroundColor: palette.dangerDeep, alignItems: 'center', justifyContent: 'center' }, badgeText: { color: '#FFFFFF', fontSize: 11, lineHeight: 14, fontWeight: '700' }, heroLabel: { ...type.label, color: palette.onNavyMuted }, heroValue: { ...type.amountHero, color: palette.onNavy, marginTop: 8 }, heroHint: { ...type.caption, color: palette.onNavySoft, marginTop: 8 }, heroTitle: { ...type.heading, color: palette.onNavy, marginTop: 14 }, metricRow: { flexDirection: 'row', alignItems: 'stretch', borderTopWidth: 1, borderTopColor: palette.navyBorder, marginTop: 20, paddingTop: 16 }, metric: { flex: 1, minWidth: 0 }, metricDivider: { width: 1, backgroundColor: palette.navyBorder, marginHorizontal: 14 }, metricLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 6 }, metricLabel: { flex: 1, flexShrink: 1 }, metricIcon: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }, metricValue: { ...type.amountMd, marginTop: 8 }, sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 24, marginBottom: 12, minHeight: 28 }, sectionTitle: { ...type.section }, link: { ...type.link, color: palette.accentText, paddingVertical: 6 }, actionRow: { flexDirection: 'row', gap: 12 }, actionButton: { flex: 1, minHeight: 76, borderRadius: radius.lg, borderWidth: 1, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12, overflow: 'hidden' }, actionIcon: { width: 44, height: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' }, actionLabel: { ...type.bodyStrong }, actionHint: { ...type.caption, marginTop: 3 }, card: { borderRadius: radius.lg, borderWidth: 1, padding: 18 }, cardTitle: { ...type.cardTitle }, flowValue: { ...type.amountLg, marginTop: 8 }, flowHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }, flowMonth: { ...type.captionStrong }, flowSplit: { flexDirection: 'row', gap: 16, marginTop: 12 }, flowItem: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 }, flowDot: { width: 8, height: 8, borderRadius: 4 }, flowItemLabel: { ...type.caption }, flowItemValue: { ...type.amountSm, marginLeft: 'auto' }, progressTrack: { height: 8, borderRadius: 4, backgroundColor: palette.border, overflow: 'hidden', marginTop: 14 }, progressFill: { height: '100%', borderRadius: 4 }, caption: { ...type.caption, marginTop: 7 }, transactionRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, borderBottomWidth: 1 }, transactionIcon: { width: 44, height: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', marginRight: 12 }, rowBody: { flex: 1 }, rowTitle: { ...type.cardTitle }, rowAmount: { ...type.amountSm }, sourceLabel: { ...type.label, marginTop: 3, textTransform: 'uppercase' }, searchBox: { minHeight: 48, borderRadius: 14, borderWidth: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 9 }, searchInput: { ...type.body, flex: 1 }, filterRow: { flexDirection: 'row', gap: 8, marginTop: 14 }, filterChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: '#E8EEF2' }, filterChipActive: { backgroundColor: palette.emeraldSoft }, filterChipText: { ...type.chip }, categoryScroll: { marginTop: 10 }, chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 18, marginRight: 7, backgroundColor: '#EEF2F4' }, chipActive: { backgroundColor: palette.emeraldSoft }, chipText: { ...type.chip }, chart: { height: 160, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center', gap: 18, paddingTop: 16 }, chartBar: { width: 46, borderRadius: 10 }, legend: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12 }, budgetRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 15 }, emptyCard: { borderRadius: 18, borderWidth: 1, padding: 20, alignItems: 'flex-start', gap: 7 }, emptyTitle: { ...type.cardTitle }, personRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 13, borderBottomWidth: 1 }, personAvatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: palette.emeraldSoft, alignItems: 'center', justifyContent: 'center', marginRight: 12 }, personInitial: { ...type.cardTitle, color: palette.navy }, profileCard: { borderRadius: 20, borderWidth: 1, alignItems: 'center', padding: 22 }, profileAvatar: { width: 64, height: 64, borderRadius: 32, backgroundColor: palette.emeraldSoft, alignItems: 'center', justifyContent: 'center' }, profileInitial: { color: palette.navy, fontSize: 26, fontWeight: '700' }, profileName: { ...type.heading, marginTop: 12 }, settingRow: { minHeight: 66, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, gap: 12 }, settingIcon: { width: 34, height: 34, borderRadius: 11, backgroundColor: palette.emeraldSoft, alignItems: 'center', justifyContent: 'center' }, logoutButton: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 20 }, fab: { position: 'absolute', right: 20, bottom: layout.navHeight + 16, width: 56, height: 56, borderRadius: 28, ...elevation.fab, backgroundColor: palette.heroStart, borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)', alignItems: 'center', justifyContent: 'center', elevation: 6, shadowColor: '#000', shadowOpacity: 0.28, shadowRadius: 8, shadowOffset: { width: 0, height: 3 } }, nav: { position: 'absolute', left: 0, right: 0, bottom: 0, height: layout.navHeight, borderTopWidth: 1, flexDirection: 'row', justifyContent: 'space-around', paddingTop: 7 }, navItem: { flex: 1, alignItems: 'center', gap: 3 }, navPillWrap: { width: layout.navPill.width, height: layout.navPill.height, alignItems: 'center', justifyContent: 'center' }, navPill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: layout.navPill.height / 2 }, navLabel: { ...type.nav }, modalBackdrop: { flex: 1, backgroundColor: '#00000066', justifyContent: 'flex-end' }, modal: { borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 22, paddingBottom: 34 }, modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }, modalTitle: { ...type.heading }, label: { ...type.label, marginTop: 15, marginBottom: 7 }, segment: { flexDirection: 'row', gap: 10 }, segmentItem: { flex: 1, minHeight: 45, borderRadius: 12, backgroundColor: '#EEF2F4', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 }, segmentActive: { backgroundColor: palette.emeraldSoft }, segmentText: { ...type.link }, input: { ...type.body, minHeight: 48, borderWidth: 1, borderRadius: 12, paddingHorizontal: 13 }, amountBox: { minHeight: 60, borderRadius: 14, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 8 }, amountSymbol: { ...type.amountLg }, amountInput: { ...type.amountInput, flex: 1, paddingVertical: 8 }, scanLink: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 18, paddingVertical: 12, borderRadius: 13, borderWidth: 1, borderStyle: 'dashed' }, primaryButton: { minHeight: 52, borderRadius: 14, backgroundColor: palette.emerald, alignItems: 'center', justifyContent: 'center', marginTop: 22 }, primaryButtonText: { ...type.button, color: '#062119' }, outlineButton: { alignSelf: 'flex-start', paddingHorizontal: 15, paddingVertical: 10, borderRadius: 12, borderWidth: 1, borderColor: palette.emerald, marginTop: 18 }, outlineButtonText: { ...type.button, color: palette.accentText }, loading: { flex: 1, alignItems: 'center', justifyContent: 'center' }, brand: { color: palette.accentText, fontSize: 13, fontWeight: '700', letterSpacing: 3 }, welcome: { flexGrow: 1, justifyContent: 'center', padding: 26 }, logoMark: { width: 62, height: 62, borderRadius: 20, backgroundColor: '#173A4D', alignItems: 'center', justifyContent: 'center', marginBottom: 20 }, welcomeTitle: { color: '#FFFFFF', fontSize: 40, lineHeight: 46, fontWeight: '700', marginTop: 30 }, welcomeDescription: { color: '#D6E1E9', fontSize: 17, lineHeight: 25, marginTop: 18 }, productDescriptor: { color: palette.accentText, fontSize: 12, fontWeight: '700', marginTop: 22 }, secondaryButton: { minHeight: 52, borderRadius: 13, borderWidth: 1, borderColor: '#45617B', alignItems: 'center', justifyContent: 'center', marginTop: 12 }, secondaryButtonText: { ...type.button, color: '#FFFFFF' }, formScreen: { padding: 24, paddingBottom: 50 }, authTitle: { ...type.title, marginTop: 18 }, subtitle: { ...type.body, marginBottom: 12 }, authField: { marginTop: 17 }, authInputWrap: { minHeight: 50, borderRadius: 12, borderWidth: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 13, gap: 9 }, inputBare: { ...type.body, flex: 1, paddingVertical: 12 }, termsRow: { flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 18 }, checkbox: { width: 21, height: 21, borderRadius: 6, borderWidth: 1, borderColor: '#92A0AD', alignItems: 'center', justifyContent: 'center' }, checkboxActive: { backgroundColor: palette.emerald, borderColor: palette.emerald }, errorText: { ...type.caption, color: palette.expenseText, marginTop: 15 }, noticeText: { ...type.caption, color: palette.warning, marginTop: 15 },
});

let styles = buildStyles();
let stylesAccent: string = 'emerald';
