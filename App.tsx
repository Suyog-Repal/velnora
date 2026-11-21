import { StatusBar } from 'expo-status-bar';
import { AccessibilityInfo, Alert, Animated, AppState, Easing, Keyboard, KeyboardAvoidingView, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Defs, LinearGradient, Path, Stop } from 'react-native-svg';
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import { clearSession, flushPendingSession, loadSession, loadSessionDetailed, login, logout, refreshSessionShared as refreshSession, register, requestPasswordReset, saveSession, type Session } from './auth';
import { restoreSession } from './src/services/sessionRestore';
import { refreshFailureKind } from './src/services/sessionRefresh';
import { NOTICE_SESSION_ENDED, launchNotice, launchNoticeText, setSignedInMarker, wasSignedIn } from './src/services/sessionNotices';
import type { LoadStatus } from './src/services/sessionPersistence';
import { SignInCheckNotice } from './src/ui/SignInCheckNotice';
import NetInfo from '@react-native-community/netinfo';
import { diag, diagnostics } from './src/services/diagnostics';
import { getGuestDataSummary, importGuestData, isGuestModeChosen, setGuestModeChosen } from './src/services/guestModeService';
import { addSmsStagedListener, configureSupportedSenderPatterns, getNativeCheckIn, getNativeReviewNotifier } from './sms';
import { confirmCheckInToday, setCheckInPort, syncCheckInSchedule } from './src/services/dailyCheckIn';
import { drainNativeReviewActions } from './src/services/reviewActionDrain.native';
import { REVIEW_SETTLE_MS, cancelReviewNotification, clearReviewNotifications, runReviewPass, setReviewNotifierPort } from './src/services/reviewNotifications';
import { createReviewLinkRouter, resolveReviewTarget, type ReviewLink } from './src/services/reviewLinks';
import { clearSmsOwner, drainNativeStagedSms, recordSmsOwner } from './src/services/smsStagingService';
import { LocalDataSection } from './src/components/LocalDataSection';
import { SmsStagingStatusSection } from './src/components/SmsStagingStatusSection';
import { DEFAULT_SMS_RULE, parseSmsTransaction } from './transactionParser';
import { type } from './typography';
import { applyAccent, applyScheme, elevation, isDarkScheme, layout, radius, tint, palette, useAccent, useCurrency, useResolvedScheme, useThemeMode, type ThemeMode } from './theme';
import { ProfileView } from './src/screens/ProfileView';
import { PeopleView } from './src/screens/PeopleView';
import { findOpenForPerson, outstandingPaise, recordPayment } from './src/services/expectedPaymentService';
import { PrivacyPage, SettingsPage } from './src/screens/SettingsPages';
import { CURRENCIES } from './src/ui/currency';
import { ArrowDownLeft, ArrowUpRight, Bell, Chart, ChevronRight, CirclePlus, Eye, EyeOff, Home, KeyRound, LayoutGrid, LockKeyhole, LogOut, PiggyBank, Plus, Search, Settings, Sliders, Target, UserRound, Users, WalletCards, X } from './icons';
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
import { commitAttachmentChanges, syncDeletedAttachments, uploadPendingAttachments } from './src/services/attachmentService';
import { expoAttachmentApi, expoAttachmentFs } from './src/services/attachmentFiles';
import { AttachmentSection, EMPTY_DRAFT, draftChanges, type AttachmentDraft } from './src/components/AttachmentSection';
import { setSyncSessionRefresher, startSyncEngine, stopSyncEngine, triggerSync } from './src/services/syncEngine';
import { createSessionRefresher } from './src/services/sessionRefresh';
import { API_URL } from './auth';
import { Chip, Input, Sheet, TypeToggle, currencySymbol, readableOn, themeColors, useOnline } from './src/ui/common';
import { KeepAlive, notifyNearEnd, useKeyboardHeight, useStableCallback } from './src/ui/perf';
import { MOTION, useReduceMotion } from './src/ui/motion';
import { HomeHeader, MonthlySummary, QuickAccessSection, RecordedBalanceCard, SyncStatus, TodayActivityCard, fabColors } from './src/screens/HomeDashboard';
import type { QuickAccessId } from './src/services/quickAccess';
import { EMPTY_CASH_FLOW, EMPTY_LEDGER_HEALTH, getCashFlowSummary, getLedgerHealth, type CashFlowSummary, type LedgerHealth } from './src/services/cashFlowService';
import { Splash } from './src/ui/Splash';
import { VelnoraLogo } from './src/ui/VelnoraLogo';
import { PermissionSetup } from './src/components/PermissionSetup';
import { QuickAddSheet } from './src/screens/QuickAddSheet';
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
import { CategoryManager, MerchantNamesManager } from './src/screens/ManageSheets';

type Tab = 'home' | 'transactions' | 'analytics' | 'budgets' | 'people' | 'profile';
/** Inlined at build time; absent in normal builds, so the timing code is dead code there. */
const PERF_LOG = process.env.EXPO_PUBLIC_PERF_LOG === '1';
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


/** Tags a refresh with what started it, for the diagnostics log (the shared refresh may coalesce several into one request). */
const refreshFrom = (source: 'launch' | 'sync401' | 'offlineRetry') => (s: Session): Promise<Session> => { diag('refresh_start', { source }); return refreshSession(s); };

export default function App() {
  // The SMS permission explanation waits until the splash has finished so the two never overlap.
  const [splashDone, setSplashDone] = useState(false);
  // SafeAreaProvider: required by useSafeAreaInsets (tab bar / FAB sit above the system navigation bar, edge-to-edge).
  return <SafeAreaProvider><View style={{ flex: 1 }}><AppInner /><Splash onFinish={() => setSplashDone(true)} /><PermissionSetup enabled={splashDone} /></View></SafeAreaProvider>;
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
  const [attachDraft, setAttachDraft] = useState<AttachmentDraft>(EMPTY_DRAFT);
  // Set only by a reviewed "Fill in from receipt": the receipt's reference id and the note typed in its review.
  const [receiptRef, setReceiptRef] = useState<string | null>(null);
  const [receiptNote, setReceiptNote] = useState('');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false); // blocks a second tap before the `saving` state re-renders
  const [amountFocused, setAmountFocused] = useState(false);
  const [cashFlow, setCashFlow] = useState<CashFlowSummary>(EMPTY_CASH_FLOW);
  const [ledgerHealth, setLedgerHealth] = useState<LedgerHealth>(EMPTY_LEDGER_HEALTH);
  const [showReview, setShowReview] = useState(false);
  const [reviewTxId, setReviewTxId] = useState<string | null>(null);
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [showAccounts, setShowAccounts] = useState(false);
  const [showImport, setShowImport] = useState<'csv' | 'pdf' | null>(null);
  const sessionRefresher = useRef<((stale: Session) => Promise<Session | null>) | null>(null);
  const [smsStatusTick, setSmsStatusTick] = useState(0);
  const [guestMode, setGuestMode] = useState(false);
  const [showAuth, setShowAuth] = useState(false);
  const [dbReady, setDbReady] = useState(false);
  const [sessionStale, setSessionStale] = useState(false);
  // The server refused to check the sign-in (400 / 403 / 422) without calling it invalid: the session is kept and this notice is shown.
  const [verifyProblem, setVerifyProblem] = useState(false);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [importPrompt, setImportPrompt] = useState<{ count: number } | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importNotice, setImportNotice] = useState('');
  const [catViews, setCatViews] = useState<CategoryView[]>([]);
  const [txLoading, setTxLoading] = useState(true);
  const [openTx, setOpenTxState] = useState<TransactionEntity | null>(null);
  const [openTxMode, setOpenTxMode] = useState<'view' | 'edit'>('view');
  /** Tapping a saved transaction opens read-only Details; the pencil inside switches to Edit. */
  // Stable identity: list rows are memoised and receive this as onOpen (a new function each render would redraw every row).
  const setOpenTx = useCallback((t: TransactionEntity | null) => { setOpenTxMode('view'); setOpenTxState(t); }, []);
  const [showCats, setShowCats] = useState(false);
  const [showAliases, setShowAliases] = useState(false);
  const [drillCategory, setDrillCategory] = useState<string | null>(null);
  const [dataTick, setDataTick] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const online = useOnline();
  const scope = session?.user.id ?? null;
  const greeting = useGreeting();
  // Date/time for a new transaction. Until the person picks one, the transaction is stamped with the moment of saving.
  const [txDate, setTxDate] = useState(localYmd());
  const [txTime, setTxTime] = useState(localHm());
  const [dateTouched, setDateTouched] = useState(false);
  const [timeTouched, setTimeTouched] = useState(false);
  const [categoryTouched, setCategoryTouched] = useState(false);
  // "Synced" / "saved offline" notices come from real sync outcomes only. Any cycle that changed data (including the
  // engine's own reconnect / retry cycles) also refreshes the screen, so "waiting to sync" reflects the database.
  const reloadRef = useRef<() => Promise<void>>(async () => undefined);
  useEffect(() => onSyncResult((summary) => {
    notices.syncResult(summary);
    if (summary.pushed > 0 || summary.pulled > 0) void reloadRef.current().catch(() => undefined);
  }), []);

  // Screen transition: content fades in with a short slide from the direction of travel (no pop, no resize). A tap during a
  // running transition restarts it cleanly. With the system's reduce-motion setting on, the new tab simply appears.
  const reduceMotion = useReduceMotion();
  const enter = useRef(new Animated.Value(1)).current;
  const slideDir = useRef(1);
  // Where a Home shortcut lands inside an existing screen. Cleared by ordinary tab navigation.
  const [txPreset, setTxPreset] = useState<'all' | 'income' | 'expense'>('all');
  const [analyticsPreset, setAnalyticsPreset] = useState<'spending' | 'report'>('spending');
  const [peoplePreset, setPeoplePreset] = useState<'people' | 'expected'>('people');
  const navTo = (next: Tab) => { setTxPreset('all'); setAnalyticsPreset('spending'); setPeoplePreset('people'); changeTab(next); };
  // Each tab keeps its own scroll position; tabs stay mounted after their first visit (see KeepAlive), so switching back
  // is instant. Visiting a tab for the first time mounts it; the remaining main tabs are pre-mounted once the app is idle.
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const contentRef = useRef<ComponentRef<typeof View>>(null);
  const scrollY = useRef<Partial<Record<Tab, number>>>({});
  const [visited, setVisited] = useState<ReadonlySet<Tab>>(() => new Set<Tab>(['home']));
  // Diagnostics only (builds made with EXPO_PUBLIC_PERF_LOG=1): time from a tab tap to the second painted frame.
  const perfT0 = useRef(0);
  useEffect(() => { if (!PERF_LOG || !perfT0.current) return; const t0 = perfT0.current; requestAnimationFrame(() => requestAnimationFrame(() => console.log(`[perf] tab ${tab} ${Date.now() - t0}ms`))); }, [tab]);
  const changeTab = (next: Tab) => {
    if (next === tab) return;
    if (PERF_LOG) perfT0.current = Date.now();
    slideDir.current = TAB_ORDER.indexOf(next) >= TAB_ORDER.indexOf(tab) ? 1 : -1;
    if (next !== 'transactions') setDrillCategory(null);
    if (!visited.has(next)) setVisited((v) => new Set(v).add(next));
    setTab(next);
    // Restore where this tab was (top on its first visit) in the same frame, so no blank, out-of-range offset is shown.
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ y: scrollY.current[next] ?? 0, animated: false }));
    enter.stopAnimation();
    if (reduceMotion) { enter.setValue(1); return; }
    // Content is visible immediately (opacity never starts at 0); only a short, small slide signals the change.
    enter.setValue(0);
    Animated.timing(enter, { toValue: 1, duration: TAB_ENTER.ms, easing: MOTION.easeOut, useNativeDriver: true }).start();
  };
  const [mode, setMode, themeReady] = useThemeMode();
  const [accent, setAccent] = useAccent();
  const [currency, setCurrency] = useCurrency(setActiveCurrency);
  const scheme = useResolvedScheme(mode);
  // The accent colour is baked into StyleSheet objects: rebuild them whenever the accent changes (before children render).
  if (stylesAccent !== `${accent}-${scheme}`) { applyAccent(accent); applyScheme(scheme === 'dark'); styles = buildStyles(); stylesAccent = `${accent}-${scheme}`; }

  const dark = scheme === 'dark';
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();
  useEffect(() => {
    if (!keyboard) return;
    // Bring the focused field (e.g. a search box) into view above the keyboard.
    const t = setTimeout(() => {
      const focused = TextInput.State.currentlyFocusedInput?.() as unknown as { measureLayout?: (rel: unknown, ok: (x: number, y: number) => void, fail?: () => void) => void } | null;
      if (!focused?.measureLayout || !contentRef.current) return;
      try { focused.measureLayout(contentRef.current, (_x, y) => scrollRef.current?.scrollTo({ y: Math.max(0, y - 96), animated: true }), () => undefined); } catch { /* best effort */ }
    }, 60);
    return () => clearTimeout(t);
  }, [keyboard]);
  const narrow = useWindowDimensions().width < 360; // small phones: tighter gutters so amounts keep room
  const colors = useMemo(() => themeColors(dark), [dark, accent]); // stable object: memoised rows rely on it
  const contacts = useMemo(() => {
    const map = new Map<string, Contact>();
    transactions.forEach((item) => { const current = map.get(item.counterparty) ?? { name: item.counterparty, received: 0, paid: 0, count: 0 }; current.count += 1; if (item.direction === 'income') current.received += item.amount; else current.paid += item.amount; map.set(item.counterparty, current); });
    return [...map.values()].sort((a, b) => b.count - a.count);
  }, [transactions]);

  // After each sync, upload receipts whose transactions the server now has, then sync the resulting reference.
  useEffect(() => {
    setPostSyncHook(async (s) => {
      const db = getServiceDb();
      const r = await uploadPendingReceipts(db, expoReceiptFs, expoReceiptUploader(API_URL), s);
      // Attachments ride on the same engine: after every cycle, upload what the server can now accept and send deletions.
      // Their failures are isolated: they never change a transaction's sync state.
      const api = expoAttachmentApi(API_URL);
      await uploadPendingAttachments(db, expoAttachmentFs, api, s, (stale) => sessionRefresher.current?.(stale) ?? Promise.resolve(null)).catch(() => undefined);
      await syncDeletedAttachments(db, api, s).catch(() => undefined);
      if (r.uploaded > 0) await triggerSync(s);
    });
    return () => setPostSyncHook(null);
  }, []);

  // The server definitively rejected the refresh token: this is "sign in again", never a silent switch to guest mode. The persisted
  // guest choice is cleared too, otherwise an earlier "continue without an account" would turn this into guest mode on its own.
  const endSessionToSignIn = () => {
    setAuthNotice(NOTICE_SESSION_ENDED); diag('notice_shown', { notice: 'session_ended' });
    void setGuestModeChosen(false).catch(() => undefined);
    setGuestMode(false); setAuthScreen('signin'); setShowAuth(true);
  };

  // A sync rejected with 401 (15-minute access token expired) refreshes the session once, then retries; see sessionRefresh.ts.
  useEffect(() => {
    const refresher = createSessionRefresher<Session>({
      loadStored: loadSession,
      refresh: refreshFrom('sync401'),
      onRefreshed: (next) => setSession((current) => (current && current.user.id === next.user.id ? next : current)),
      onRejected: (rejected) => {
        void clearSession('sync401_rejected');
        setSession((current) => (current?.user.id === rejected.user.id ? null : current));
        endSessionToSignIn();
      },
      onUnverifiable: () => setVerifyProblem(true), // keep the session; the notice offers Retry / Sign in again
    });
    sessionRefresher.current = refresher;
    setSyncSessionRefresher((stale) => refresher(stale as Session)); // the app only ever passes full Sessions to triggerSync
    return () => { sessionRefresher.current = null; setSyncSessionRefresher(null); };
  }, []);

  // Restore the stored session without destroying it on a transient failure (offline, 5xx).
  // Only an explicit server rejection of the refresh token ends the session; local data is never touched.
  useEffect(() => {
    // The first screen comes from local data at once; the refresh runs behind it, so a slow or sleeping server never delays launch.
    // A keystore that is not ready yet can fail to read; that is not "no session". Look twice before treating it as signed out, and
    // remember WHY there is no session so the sign-in screen can say so (see sessionNotices.ts). Nothing stored is ever deleted here.
    const readOnce = async () => { const first = await loadSessionDetailed(); return first.status === 'read_error' ? new Promise<Awaited<ReturnType<typeof loadSessionDetailed>>>((resolve) => setTimeout(() => loadSessionDetailed().then(resolve), 600)) : first; };
    readOnce().then((loaded) => {
      launchSessionStatus.current = loaded.status;
      const stored = loaded.status === 'ok' ? loaded.session : null;
      if (stored) setSession(stored);
      setAuthReady(true);
      if (!stored) return;
      void restoreSession(stored, refreshFrom('launch')).then(async (result) => {
        if (result.status === 'expired') { await clearSession('launch_expired'); endSessionToSignIn(); }
        if (result.status === 'unverified') setVerifyProblem(true);
        // Only apply this to the session it was started for (the person may have signed out meanwhile).
        setSession((current) => (current?.refresh_token === stored.refresh_token ? result.session : current));
        setSessionStale(result.status === 'offline');
      });
    }).catch(() => setAuthReady(true));
  }, []);

  // Why the app opened signed out (once the database is ready): the saved sign-in could not be read, or none was found although
  // this device was signed in before (a reinstall or restore). A first run shows nothing. "Session ended" (401) is set elsewhere.
  const launchSessionStatus = useRef<LoadStatus | null>(null);
  const launchNoticeDone = useRef(false);
  useEffect(() => {
    if (!authReady || !dbReady || launchNoticeDone.current) return;
    launchNoticeDone.current = true;
    const status = launchSessionStatus.current;
    if (!status || status === 'ok') return;
    void (async () => {
      const db = getServiceDb();
      const notice = launchNotice(status, await wasSignedIn(db).catch(() => false));
      if (!notice) return;
      if (notice === 'no_session') await setSignedInMarker(db, false).catch(() => undefined); // shown once
      if (!guestMode) { setAuthNotice(launchNoticeText(notice)); diag('notice_shown', { notice }); }
    })();
  }, [authReady, dbReady, guestMode]);

  // Keep the "this device was signed in" marker in step with the session: set while signed in, cleared when the app ends it.
  const previousSession = useRef<Session | null>(null);
  useEffect(() => {
    if (!dbReady) return;
    const had = previousSession.current; previousSession.current = session;
    let db; try { db = getServiceDb(); } catch { return; }
    if (session) void setSignedInMarker(db, true).catch(() => undefined);
    else if (had) void setSignedInMarker(db, false).catch(() => undefined);
  }, [session?.user.id, dbReady]); // eslint-disable-line react-hooks/exhaustive-deps

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
  reloadRef.current = reloadData;

  // Tapping a review notification. Links are held until the database and session are ready (cold start).
  useEffect(() => { setReviewNotifierPort(getNativeReviewNotifier()); setCheckInPort(getNativeCheckIn()); }, []);
  // Hand the saved check-in setting to the native alarm at every start (also repairs it after a data clear or update).
  useEffect(() => { if (dbReady) void syncCheckInSchedule(getServiceDb()).catch(() => undefined); }, [dbReady]);
  const handleReviewLink = useRef<(link: ReviewLink) => void>(() => undefined);
  handleReviewLink.current = (link) => {
    if (link.kind === 'quick-add') { setShowQuickAdd(true); return; }
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

  // A session restored while offline (or one the server could not verify) may hold an expired access token: try the refresh again.
  // Only a 401 ends the session. 400 / 403 / 422 keep it and show "Can't verify your sign-in"; a network failure just waits.
  const checkSignIn = useCallback(async (current: Session): Promise<'ok' | 'unverified' | 'ended' | 'unreachable'> => {
    try {
      const next = await refreshFrom('offlineRetry')(current);
      setSession((s) => (s && s.user.id === next.user.id ? next : s)); setSessionStale(false); setVerifyProblem(false);
      return 'ok';
    } catch (err) {
      const kind = refreshFailureKind(err);
      if (kind === 'rejected') { await clearSession('check_sign_in_rejected'); setSession(null); setSessionStale(false); setVerifyProblem(false); endSessionToSignIn(); return 'ended'; }
      if (kind === 'unverifiable') { setVerifyProblem(true); return 'unverified'; }
      return 'unreachable';
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!session || !(sessionStale || verifyProblem)) return;
    let cancelled = false;
    const retry = () => { if (!cancelled) void checkSignIn(session); };
    retry();
    const sub = AppState.addEventListener('change', (state) => { if (state === 'active') retry(); });
    return () => { cancelled = true; sub.remove(); };
  }, [session, sessionStale, verifyProblem, checkSignIn]);
  useEffect(() => { if (verifyProblem) diag('notice_shown', { notice: 'cant_verify' }); }, [verifyProblem]);
  // App state and network type are stamped on every diagnostics event, and their changes are events too.
  useEffect(() => {
    diagnostics.setContext({ app: AppState.currentState ?? undefined });
    const app = AppState.addEventListener('change', (state) => { diagnostics.setContext({ app: state }); diag('app_state', { state }); });
    const net = NetInfo.addEventListener((state) => { diagnostics.setContext({ net: state.type }); diag('network', { type: state.type, connected: !!state.isConnected }); });
    return () => { app.remove(); net(); };
  }, []);
  const retrySignInCheck = async () => {
    if (!session || verifyBusy) return;
    setVerifyBusy(true);
    const result = await checkSignIn(session);
    setVerifyBusy(false);
    if (result === 'unverified') showToast("Still can't verify your sign-in. Try again later or sign in again.", 'warning', 'verify-retry');
    else if (result === 'unreachable') showToast("Couldn't reach Velnora. Check your connection and try again.", 'warning', 'verify-retry');
  };
  // The person chose to sign in again: the stored tokens are cleared (local data stays), like after a 401 but with its own wording.
  const signInAgainFromNotice = async () => {
    await clearSession('sign_in_again_notice').catch(() => undefined);
    setAuthNotice("Sign in again to keep syncing. Your data on this device is preserved."); diag('notice_shown', { notice: 'sign_in_again' });
    void setGuestModeChosen(false).catch(() => undefined);
    setGuestMode(false); setSession(null); setSessionStale(false); setVerifyProblem(false); setAuthScreen('signin'); setShowAuth(true);
  };

  // A refreshed session that secure storage refused to write is kept in memory and retried (auth.ts); also try when the app returns.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => { if (state === 'active') void flushPendingSession(); });
    return () => sub.remove();
  }, []);

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
        // Category buttons tapped on notifications are applied first (they may have been queued while the app was closed).
        const actions = await drainNativeReviewActions(session).catch(() => null);
        const summary = await drainNativeStagedSms(session, smsRules);
        // A background task may have saved payments while the app was away, so coming back always refreshes.
        if (active && summary && (summary.saved > 0 || summary.duplicates > 0) || (active && actions && actions.applied > 0) || (active && returnedToApp)) await reloadData();
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
    setAmount(''); setCounterparty(''); setFormError(''); setAttachDraft(EMPTY_DRAFT); setReceiptRef(null); setReceiptNote('');
    setTxDate(localYmd()); setTxTime(localHm()); setDateTouched(false); setTimeTouched(false); setCategoryTouched(false);
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
        description: receiptNote.trim() || (savedDirection === 'income' ? `Received from ${counterparty.trim()}` : `Paid to ${counterparty.trim()}`),
        source: 'manual',
        ...(receiptRef ? { reference_id: receiptRef } : {}),
        ...(when ? { transaction_date: when } : {}),
      }, session);
      notices.localSave(savedDirection, !!session);
      // Attachments are stored after the transaction (they reference its id). Each is stored on its own, so one unreadable
      // image never loses the transaction or the other images.
      const attachChanges = draftChanges(attachDraft);
      if (attachChanges.added.length) {
        const res = await commitAttachmentChanges(getServiceDb(), expoAttachmentFs, session, created.id, attachChanges).catch(() => ({ added: 0, removed: 0, failed: attachChanges.added.length }));
        if (res.failed > 0) showToast(`${res.failed} attachment${res.failed === 1 ? '' : 's'} could not be saved. The transaction was saved.`, 'warning', 'attach-failed');
        if (session && res.added > 0) void syncPendingTransactions(session).catch(() => undefined);
      }
      setAttachDraft(EMPTY_DRAFT);
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
  useEffect(() => {
    if (!dbReady) return;
    let cancelled = false;
    const order: Tab[] = ['transactions', 'people', 'analytics', 'budgets'];
    // After the first screen has settled: one tab at a time, spaced out so a tap is never queued behind a mount.
    const timers = order.map((t, i) => setTimeout(() => { if (!cancelled) setVisited((v) => (v.has(t) ? v : new Set(v).add(t))); }, 1500 + i * 400));
    return () => { cancelled = true; timers.forEach(clearTimeout); };
  }, [dbReady]);
  const openAuth = (screen: 'signin' | 'signup') => { setAuthScreen(screen); setShowAuth(true); };
  /** Home Quick Access: each shortcut opens an EXISTING flow (no new screens or financial logic). */
  const quickAccess = (id: QuickAccessId) => {
    if (id === 'add') { openForm('expense'); return; }                                  // the transaction form (type switch inside)
    if (id === 'expected') { navTo('people'); setPeoplePreset('expected'); return; }   // People -> Expected payments
    if (id === 'report') { navTo('analytics'); setAnalyticsPreset('report'); return; } // Analytics -> Monthly report
    Alert.alert('Record a transaction', 'Is this money you received or money you spent?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Income', onPress: () => openForm('income') },
      { text: 'Expense', onPress: () => openForm('expense') },
    ], { cancelable: true });
  };

  if (!themeReady) return null; // a few ms: avoids drawing the default theme before the saved one is known
  if (!authReady || !dbReady) return <AuthLoading colors={colors} />;
  if (!session && !inGuest) return <AuthScreens onGuest={continueAsGuest} screen={authScreen} setScreen={setAuthScreen} fullName={fullName} setFullName={setFullName} email={email} setEmail={setEmail} password={password} setPassword={setPassword} confirmPassword={confirmPassword} setConfirmPassword={setConfirmPassword} showPassword={showPassword} setShowPassword={setShowPassword} termsAccepted={termsAccepted} setTermsAccepted={setTermsAccepted} busy={authBusy} error={authError} notice={authNotice} onSubmit={submitAuth} onForgot={submitForgot} colors={colors} />;

  return <SafeAreaView edges={['top', 'left', 'right']} style={[styles.safe, { backgroundColor: colors.canvas }]}><StatusBar style={dark ? 'light' : 'dark'} /><View style={styles.shell}>
    <ScrollView ref={scrollRef} onScroll={(e) => { const n = e.nativeEvent; scrollY.current[tab] = n.contentOffset.y; if (n.contentSize.height - (n.contentOffset.y + n.layoutMeasurement.height) < 1200) notifyNearEnd(); }} scrollEventThrottle={64} keyboardDismissMode="on-drag"
      contentContainerStyle={[styles.content, narrow && { padding: 16 }, { paddingBottom: keyboard ? keyboard + 24 : layout.navHeight + insets.bottom + 54 + 40 }]} keyboardShouldPersistTaps="handled"><View ref={contentRef} collapsable={false}>
      {tab === 'home' ? <HomeHeader greeting={`${greeting}${session ? `, ${session.user.full_name.split(' ')[0]}` : ''}`} initial={session ? session.user.full_name.charAt(0).toUpperCase() : 'G'} reviewCount={ledgerHealth.needsReviewCount} colors={colors} dark={dark} onProfile={() => navTo('profile')} onSearch={() => navTo('transactions')} onNotifications={() => setShowReview(true)} />
      : <View style={styles.header}><View><Text style={[styles.overline, { color: palette.accentText }]}>VELNORA</Text><Text style={[styles.title, { color: colors.text }]}>{tab.charAt(0).toUpperCase() + tab.slice(1)}</Text></View><Pressable style={[styles.iconButton, { backgroundColor: colors.card, borderColor: colors.border }]} onPress={() => changeTab('profile')}><Text style={[styles.avatarText, { color: colors.text }]}>{session ? session.user.full_name.charAt(0).toUpperCase() : 'G'}</Text></Pressable></View>}
      {!session && <Text style={[styles.caption, { color: colors.muted, marginBottom: 12 }]}>Guest mode · data stays on this device and is not synced.</Text>}
      {importNotice ? <Text style={styles.noticeText}>{importNotice}</Text> : null}
      {session && verifyProblem ? <SignInCheckNotice colors={colors} busy={verifyBusy} onRetry={() => void retrySignInCheck()} onSignInAgain={() => void signInAgainFromNotice()} /> : null}
      {tab === 'home' ? <SyncStatus offline={!!session && sessionStale && !verifyProblem} colors={colors} />
        : session && sessionStale && !verifyProblem ? <Text style={[styles.caption, { color: colors.muted, marginBottom: 12 }]}>Offline · working from local data; sync resumes when you reconnect.</Text> : null}
      <Animated.View style={{ opacity: enter.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1] }), transform: [{ translateX: enter.interpolate({ inputRange: [0, 1], outputRange: [slideDir.current * TAB_ENTER.offsetDp, 0] }) }] }}>
      {visited.has('home') && <KeepAlive active={tab === 'home'}><HomeScreen scope={scope} onOpen={setOpenTx} transactions={transactions} cashFlow={cashFlow} health={ledgerHealth} onReview={() => setShowReview(true)} colors={colors} dark={dark} onAddExpense={() => openForm('expense')} onViewAll={() => navTo('transactions')} onAnalytics={() => navTo('analytics')}
        onTransactions={(type) => { navTo('transactions'); setTxPreset(type); }} onQuickAccess={(id) => quickAccess(id)} /></KeepAlive>}
      {visited.has('transactions') && <KeepAlive active={tab === 'transactions'}><TransactionsView scope={scope} key={`${drillCategory ?? 'all'}-${txPreset}`} transactions={transactions} categories={catViews} colors={colors} loading={txLoading} online={online} onOpen={setOpenTx} onAdd={() => openForm('expense')} initialCategory={drillCategory} initialType={txPreset} /></KeepAlive>}
      {visited.has('analytics') && <KeepAlive active={tab === 'analytics'}><AnalyticsView key={analyticsPreset} scope={scope} colors={colors} refreshKey={dataTick} initialSection={analyticsPreset} onDrill={(c) => { setDrillCategory(c); changeTab('transactions'); }} /></KeepAlive>}
      {visited.has('budgets') && <KeepAlive active={tab === 'budgets'}><BudgetsView scope={scope} categories={catViews} colors={colors} refreshKey={dataTick} /></KeepAlive>}
            {visited.has('people') && <KeepAlive active={tab === 'people'}><PeopleView key={peoplePreset} initialTab={peoplePreset} transactions={transactions} categories={catViews} session={session} colors={colors} refreshKey={dataTick} onOpenTx={setOpenTx} onChanged={() => void reloadData()} onAddTransaction={() => openForm('expense')} /></KeepAlive>}
      {visited.has('profile') && <KeepAlive active={tab === 'profile'}><ProfileView session={session} colors={colors} transactions={transactions} online={online} onOpenSettings={() => setShowSettings(true)} onOpenPrivacy={() => setShowPrivacy(true)}
        onOpenCategories={() => setShowCats(true)} onOpenAliases={() => setShowAliases(true)} reviewCount={ledgerHealth.needsReviewCount} onOpenReview={() => setShowReview(true)} onOpenAccounts={() => setShowAccounts(true)} onOpenImport={() => setShowImport('csv')} onOpenImportPdf={() => setShowImport('pdf')} onSignIn={() => openAuth('signin')} onCreate={() => openAuth('signup')}
        onLogout={async () => { if (!session) return; await clearReviewNotifications(getServiceDb(), session.user.id).catch(() => undefined); await logout(session); setSession(null); setSessionStale(false); setTransactions([]); setAuthScreen('welcome'); setShowAuth(true); }} /></KeepAlive>}
      </Animated.View>
    </View></ScrollView>
    {tab !== 'profile' && !keyboard && <Pressable style={({ pressed }) => [styles.fab, { bottom: layout.navHeight + insets.bottom + 16, backgroundColor: fabColors().bg }, pressed && { opacity: 0.9, transform: [{ scale: 0.96 }] }]} onPress={() => openForm('expense')} accessibilityRole="button" accessibilityLabel="Add transaction"><Plus color={fabColors().fg} size={24} strokeWidth={2.4} /></Pressable>}
    <ToastHost bottom={layout.navHeight + insets.bottom + 76} />
    {!keyboard && <BottomNav tab={tab} setTab={navTo} colors={colors} dark={dark} reduceMotion={reduceMotion} />}
  </View>
  <Modal visible={importPrompt !== null} transparent animationType="fade" onRequestClose={() => setImportPrompt(null)}><View style={styles.modalBackdrop}><View style={[styles.modal, { backgroundColor: colors.card }]}>
    <Text style={[styles.modalTitle, { color: colors.text }]}>Import local data?</Text>
    <Text style={[styles.caption, { color: colors.muted, marginVertical: 12 }]}>{importPrompt?.count ?? 0} transaction{importPrompt?.count === 1 ? '' : 's'} recorded without an account exist on this device. Importing associates them with {session?.user.email ?? 'this account'} and uploads them to sync. If you cancel, they stay on this device, separate from your account, and nothing is uploaded.</Text>
    <Pressable disabled={importBusy} style={styles.primaryButton} onPress={() => void confirmImport()}><Text style={styles.primaryButtonText}>{importBusy ? 'Importing...' : 'Import and sync'}</Text></Pressable>
    <Pressable disabled={importBusy} onPress={() => setImportPrompt(null)}><Text style={[styles.link, { textAlign: 'center', marginTop: 16 }]}>Not now</Text></Pressable>
  </View></View></Modal>
  <QuickAddSheet visible={showQuickAdd} session={session} scope={scope} colors={colors} onClose={() => setShowQuickAdd(false)} onSaved={(created) => {
    setShowQuickAdd(false); confirmCheckInToday();
    const uiRecord = toUiTransaction(created);
    setTransactions((current) => [uiRecord, ...current.filter((item) => item.id !== uiRecord.id)]);
    setDataTick((n) => n + 1); // reports, charts and the cash-flow summary re-read the saved ledger
    notices.localSave('expense', !!session);
  }} />
  <ReviewSheet visible={showReview} session={session} colors={colors} onClose={() => setShowReview(false)} onComplete={setReviewTxId} />
  <CompleteTransactionSheet transactionId={reviewTxId} session={session} categories={catViews} colors={colors} onClose={() => setReviewTxId(null)} onChanged={() => void reloadData()} onEdit={(t) => { setOpenTxMode('edit'); setOpenTxState(t); }} />
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
      {formCategories.map((item) => <Chip key={item} label={item} active={category.toLowerCase() === item.toLowerCase()} color={catViews.find((c) => c.type === direction && c.name === item)?.color} onPress={() => { setCategory(item); setCategoryTouched(true); }} colors={colors} />)}
    </ScrollView>
    <AttachmentSection draft={attachDraft} onChange={setAttachDraft} colors={colors} signedIn={!!session} receipt={{
      session, categories: catViews,
      current: { direction, merchant: counterparty, amount, date: txDate, time: txTime, category,
        // Defaults (today, the first category) are fallbacks, not entries: only what the person set can conflict.
        entered: { merchant: true, amount: true, date: dateTouched, time: timeTouched, category: categoryTouched } },
      // The person reviewed and confirmed these in the receipt sheet; they become the form's values (still editable here).
      onApply: (r) => {
        setDirection(r.direction); setAmount(r.amount); setCounterparty(r.merchant);
        const list = categoriesFor(r.direction);
        setCategory(list.find((n) => n.toLowerCase() === r.category.toLowerCase()) ?? list[0]);
        setTxDate(r.date); setTxTime(r.time); setDateTouched(true); setTimeTouched(true); setCategoryTouched(true);
        setReceiptRef(r.referenceId); setReceiptNote(r.note); setFormError('');
      },
    }} />
  </Sheet>
  <TransactionSheet key={openTx?.id ?? 'none'} tx={openTx} initialMode={openTxMode} session={session} categories={catViews} colors={colors} onClose={() => setOpenTx(null)} onChanged={() => void reloadData()} />
  <SettingsPage visible={showSettings} onClose={() => setShowSettings(false)} colors={colors} mode={mode} setMode={setMode} accent={accent} setAccent={setAccent} scope={scope} currency={currency} setCurrency={setCurrency} />
  <PrivacyPage visible={showPrivacy && !!session} onClose={() => setShowPrivacy(false)} colors={colors}
    deleteSection={session ? <LocalDataSection userId={session.user.id} colors={colors} onDeleted={() => { setTransactions([]); setSmsStatusTick((n) => n + 1); }} /> : null}
    smsSection={session ? <SmsStagingStatusSection userId={session.user.id} colors={colors} refreshKey={smsStatusTick} /> : null} />
  <CategoryManager visible={showCats} scope={scope} colors={colors} onClose={() => setShowCats(false)} onChanged={() => void reloadData()} />
  <MerchantNamesManager visible={showAliases} userId={scope} colors={colors} onClose={() => setShowAliases(false)} />
  </SafeAreaView>;
}

function HomeScreen({ scope, onOpen, transactions, cashFlow, health, onReview, colors, dark, onAddExpense, onViewAll, onAnalytics, onTransactions, onQuickAccess }: { scope: string | null; onOpen: (tx: TransactionEntity) => void; transactions: Transaction[]; cashFlow: CashFlowSummary; health: LedgerHealth; onReview: () => void; colors: Colors; dark: boolean; onAddExpense: () => void; onViewAll: () => void; onAnalytics: () => void; onTransactions: (type: 'all' | 'income' | 'expense') => void; onQuickAccess: (id: QuickAccessId) => void }) {
  // Stable callbacks: the memoised sections below then skip re-rendering when Home is shown again (fast tab switches).
  const onIncome = useStableCallback(() => onTransactions('income'));
  const onExpenses = useStableCallback(() => onTransactions('expense'));
  const onOpenList = useStableCallback(() => onTransactions('all'));
  const onReviewStable = useStableCallback(onReview);
  const onQuickAccessStable = useStableCallback(onQuickAccess);
  const byId = useMemo(() => new Map(transactions.map((t) => [t.id, t])), [transactions]);
  const renderTransaction = useCallback((id: string) => {
    const item = byId.get(id);
    return item ? <Pressable onPress={() => onOpen(item)} accessibilityRole="button"><TransactionRow item={item} colors={colors} /></Pressable> : null;
  }, [byId, colors, onOpen]);
  return <>
    <RecordedBalanceCard balancePaise={cashFlow.balancePaise} colors={colors} dark={dark} />
    <MonthlySummary cashFlow={cashFlow} colors={colors} onIncome={onIncome} onExpenses={onExpenses} />
    <QuickAccessSection colors={colors} onAction={onQuickAccessStable} />
    <TodayActivityCard health={health} colors={colors} dark={dark} onReview={onReviewStable} onOpenList={onOpenList} />
    <SectionHeader title="Spending overview" action="Analytics" onPress={onAnalytics} colors={colors} />
    <SpendingOverview scope={scope} refreshKey={transactions} colors={colors} transactions={transactions} renderTransaction={renderTransaction} />
    <SectionHeader title="Recent transactions" action="See all" onPress={onViewAll} colors={colors} />
    {transactions.length ? <View style={[styles.listCard, { backgroundColor: colors.card, borderColor: colors.border }]}>{transactions.slice(0, 5).map((item, i, arr) => <Pressable key={item.id} onPress={() => onOpen(item)} accessibilityRole="button" android_ripple={{ color: tint(palette.emerald, 0.1) }}><TransactionRow item={item} colors={colors} last={i === arr.length - 1} /></Pressable>)}</View> : <EmptyState colors={colors} onAdd={onAddExpense} />}
  </>;
}

function TransactionsScreen({ transactions, categories = DEFAULT_CATEGORIES, colors, onAdd }: { transactions: Transaction[]; categories?: string[]; colors: Colors; onAdd: () => void }) {
  const [query, setQuery] = useState(''); const [filter, setFilter] = useState<'all' | Direction>('all'); const [categoryFilter, setCategoryFilter] = useState('All categories');
  const filtered = transactions.filter((item) => (filter === 'all' || item.direction === filter) && (categoryFilter === 'All categories' || item.category === categoryFilter) && `${item.counterparty} ${item.category}`.toLowerCase().includes(query.toLowerCase()));
  return <><View style={[styles.searchBox, { backgroundColor: colors.card, borderColor: colors.border }]}><Search color={colors.muted} size={18} /><TextInput value={query} onChangeText={setQuery} placeholder="Search transactions" placeholderTextColor={colors.muted} style={[styles.searchInput, { color: colors.text }]} /></View><View style={styles.filterRow}>{(['all', 'income', 'expense'] as const).map((item) => <Pressable key={item} onPress={() => setFilter(item)} style={[styles.filterChip, filter === item && styles.filterChipActive]}><Text style={[styles.filterChipText, { color: filter === item ? palette.accentText : colors.muted }]}>{item === 'all' ? 'All' : item === 'income' ? 'Income' : 'Expenses'}</Text></Pressable>)}</View><ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.categoryScroll}>{['All categories', ...new Set(categories)].map((item) => <Pressable key={item} onPress={() => setCategoryFilter(item)} style={[styles.chip, categoryFilter === item && styles.chipActive]}><Text style={[styles.chipText, { color: categoryFilter === item ? palette.accentText : colors.muted }]}>{item}</Text></Pressable>)}</ScrollView><SectionHeader title={`${filtered.length} transactions`} action="Add" onPress={onAdd} colors={colors} />{filtered.length ? filtered.map((item) => <TransactionRow key={item.id} item={item} colors={colors} />) : <EmptyState colors={colors} onAdd={onAdd} />}</>;
}

function AnalyticsScreen({ transactions, categories = DEFAULT_CATEGORIES, totals, colors }: { transactions: Transaction[]; categories?: string[]; totals: { income: number; expense: number }; colors: Colors }) {
  const categoryTotals = categories.map((name) => ({ name, value: transactions.filter((item) => item.category === name && item.direction === 'expense').reduce((sum, item) => sum + item.amount, 0) })).filter((item) => item.value > 0);
  const max = Math.max(1, ...categoryTotals.map((item) => item.value));
  return <><View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}><Text style={[styles.cardTitle, { color: colors.text }]}>Income vs expenses</Text><View style={styles.chart}><View style={[styles.chartBar, { height: Math.max(12, Math.min(140, totals.income / 10)), backgroundColor: palette.emerald }]} /><View style={[styles.chartBar, { height: Math.max(12, Math.min(140, totals.expense / 10)), backgroundColor: palette.danger }]} /></View><View style={styles.legend}><Text style={[styles.caption, { color: colors.muted }]}>Income {money(totals.income)}</Text><Text style={[styles.caption, { color: colors.muted }]}>Expenses {money(totals.expense)}</Text></View></View><SectionHeader title="Category spending" colors={colors} />{categoryTotals.length ? categoryTotals.map((item) => <View key={item.name} style={styles.budgetRow}><View style={styles.rowBody}><Text style={[styles.rowTitle, { color: colors.text }]}>{item.name}</Text><View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${item.value / max * 100}%`, backgroundColor: palette.emerald }]} /></View></View><Text style={[styles.rowAmount, { color: colors.text }]}>{money(item.value)}</Text></View>) : <EmptyState colors={colors} onAdd={() => {}} />}</>;
}

function BudgetsScreen({ colors, onAdd }: { colors: Colors; onAdd: () => void }) { return <><View style={[styles.card, { backgroundColor: palette.navy, borderColor: palette.navy }]}><Target color={palette.emerald} size={28} /><Text style={styles.heroTitle}>Plan your month with intention</Text><Text style={styles.heroHint}>Create category budgets and savings goals from your real spending.</Text><Pressable style={styles.outlineButton} onPress={onAdd}><Text style={styles.outlineButtonText}>Create a budget</Text></Pressable></View><SectionHeader title="Budget utilization" colors={colors} /><View style={[styles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}><PiggyBank color={palette.emerald} size={28} /><Text style={[styles.emptyTitle, { color: colors.text }]}>No budgets yet</Text><Text style={[styles.caption, { color: colors.muted }]}>Your budget progress will appear here after you set a monthly allocation.</Text></View><SectionHeader title="Savings goals" colors={colors} /><View style={[styles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}><Text style={[styles.emptyTitle, { color: colors.text }]}>No savings goals yet</Text><Text style={[styles.caption, { color: colors.muted }]}>Set a goal to make your next milestone visible.</Text></View></>; }

function PeopleScreen({ contacts, colors, onAdd }: { contacts: Contact[]; colors: Colors; onAdd: () => void }) { return <><Text style={[styles.subtitle, { color: colors.muted }]}>Track money received, money paid, and your recorded history with each person.</Text>{contacts.length ? contacts.map((contact) => <View key={contact.name} style={[styles.personRow, { borderBottomColor: colors.border }]}><View style={styles.personAvatar}><Text style={styles.personInitial}>{contact.name.charAt(0).toUpperCase()}</Text></View><View style={styles.rowBody}><Text style={[styles.rowTitle, { color: colors.text }]}>{contact.name}</Text><Text style={[styles.caption, { color: colors.muted }]}>{contact.count} transaction{contact.count === 1 ? '' : 's'} · Received {money(contact.received)}</Text></View><Text style={[styles.rowAmount, { color: palette.expenseText }]}>{money(contact.paid)}</Text></View>) : <EmptyState colors={colors} onAdd={onAdd} />}</>; }


type Colors = import('./src/ui/common').Colors; // one Colors type for the whole app (src/ui/common)
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
/** Bottom-navigation tap response: 3 dp up, 1.05x, ~200 ms in total, ease-out, no overshoot. */
/** Bottom-nav press feel: a physical press inwards and a smooth release. Timing-based (no spring, no overshoot). */
const NAV_TAP = { pressScale: 0.9, pressOpacity: 0.82, pressMs: 90, releaseMs: 150 } as const;
/** Tab content transition. */
const TAB_ENTER = { ms: MOTION.base, offsetDp: 10 } as const;

function NavItem({ Icon, label, active, onPress, colors, dark, reduceMotion }: { Icon: typeof Home; label: string; active: boolean; onPress: () => void; colors: Colors; dark: boolean; reduceMotion: boolean }) {
  const on = useRef(new Animated.Value(active ? 1 : 0)).current;
  // Press feedback on the icon only: scales in while the finger is down, eases back out on release. The selected state is
  // shown by the existing pill and colour; nothing lifts, pops or pulses. Native driver; the bar layout never moves.
  const press = useRef(new Animated.Value(0)).current; // 0 = at rest, 1 = fully pressed
  const pressTo = (v: 0 | 1) => {
    if (reduceMotion) return;
    press.stopAnimation();
    Animated.timing(press, {
      toValue: v, duration: v ? NAV_TAP.pressMs : NAV_TAP.releaseMs,
      easing: v ? Easing.out(Easing.quad) : Easing.out(Easing.cubic), useNativeDriver: true,
    }).start();
  };
  useEffect(() => {
    Animated.timing(on, { toValue: active ? 1 : 0, duration: reduceMotion ? 0 : 160, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [active, on, reduceMotion]);
  return <Pressable style={styles.navItem} hitSlop={{ top: 4, bottom: 4 }} onPressIn={() => pressTo(1)} onPressOut={() => pressTo(0)} onPress={onPress}
    accessibilityRole="tab" accessibilityState={{ selected: active }} accessibilityLabel={label}>
    <View style={styles.navPillWrap}>
      {/* Selected background: a rounded accent pill behind the active icon. */}
      <Animated.View pointerEvents="none" style={[styles.navPill, { backgroundColor: dark ? `${palette.emerald}38` : palette.emeraldSoft, opacity: on, transform: [{ scaleX: on.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] }) }] }]} />
      <Animated.View pointerEvents="none" style={{ opacity: press.interpolate({ inputRange: [0, 1], outputRange: [1, NAV_TAP.pressOpacity] }), transform: [{ scale: press.interpolate({ inputRange: [0, 1], outputRange: [1, NAV_TAP.pressScale] }) }] }}>
        <Icon size={20} color={active ? palette.accentText : colors.muted} strokeWidth={2} />
      </Animated.View>
    </View>
    <Text style={[styles.navLabel, { color: active ? palette.accentText : colors.muted, fontWeight: active ? '600' : '500' }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85}>{label}</Text>
  </Pressable>;
}
function BottomNav({ tab, setTab, colors, dark, reduceMotion }: { tab: Tab; setTab: (tab: Tab) => void; colors: Colors; dark: boolean; reduceMotion: boolean }) {
  const items: [Tab, typeof Home, string][] = [['home', Home, 'Home'], ['transactions', LayoutGrid, 'Transactions'], ['analytics', Chart, 'Analytics'], ['budgets', WalletCards, 'Budgets'], ['people', Users, 'People']];
  const insets = useSafeAreaInsets();
  return <View accessibilityRole="tablist" style={[styles.nav, { backgroundColor: colors.nav ?? colors.card, borderTopColor: colors.border, height: layout.navHeight + insets.bottom, paddingBottom: insets.bottom }]}>
    {items.map(([key, Icon, label]) => <NavItem key={key} Icon={Icon} label={label} active={tab === key} onPress={() => setTab(key)} colors={colors} dark={dark} reduceMotion={reduceMotion} />)}
  </View>;
}

function AuthLoading({ colors }: { colors: Colors }) { return <SafeAreaView style={[styles.safe, { backgroundColor: colors.canvas }]}><View style={styles.loading}><Text style={[styles.brand, { color: palette.accentText }]}>VELNORA</Text></View></SafeAreaView>; }
type AuthProps = { onGuest: () => void; screen: 'welcome' | 'signup' | 'signin' | 'forgot'; setScreen: (screen: 'welcome' | 'signup' | 'signin' | 'forgot') => void; fullName: string; setFullName: (value: string) => void; email: string; setEmail: (value: string) => void; password: string; setPassword: (value: string) => void; confirmPassword: string; setConfirmPassword: (value: string) => void; showPassword: boolean; setShowPassword: (value: boolean) => void; termsAccepted: boolean; setTermsAccepted: (value: boolean) => void; busy: boolean; error: string; notice: string; onSubmit: (screen: 'signup' | 'signin') => Promise<void>; onForgot: () => Promise<void>; colors: Colors };
function AuthScreens(props: AuthProps) { const signup = props.screen === 'signup'; const forgot = props.screen === 'forgot'; if (props.screen === 'welcome') return <SafeAreaView style={[styles.safe, { backgroundColor: palette.navy }]}><StatusBar style="light" /><ScrollView contentContainerStyle={styles.welcome}><View style={{ marginBottom: 14 }}><VelnoraLogo size={92} /></View><Text style={styles.brand}>VELNORA</Text><Text style={styles.welcomeTitle}>Take control of your money.</Text><Text style={styles.welcomeDescription}>Track better. Budget smarter. Manage money confidently.</Text><Text style={styles.productDescriptor}>Personal Finance & Expense Tracker</Text><Pressable style={styles.primaryButton} onPress={() => props.setScreen('signup')}><Text style={styles.primaryButtonText}>Get started</Text></Pressable><Pressable style={styles.secondaryButton} onPress={() => props.setScreen('signin')}><Text style={styles.secondaryButtonText}>I already have an account</Text></Pressable><Pressable onPress={props.onGuest}><Text style={[styles.link, { textAlign: 'center', marginTop: 20 }]}>Continue without an account</Text></Pressable></ScrollView></SafeAreaView>; return <SafeAreaView style={[styles.safe, { backgroundColor: props.colors.canvas }]}><StatusBar style={props.colors.canvas === palette.darkCanvas ? 'light' : 'dark'} /><KeyboardAvoidingView style={styles.safe} behavior="padding"><ScrollView contentContainerStyle={[styles.formScreen, { paddingBottom: 160 }]} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"><Pressable onPress={() => props.setScreen(forgot ? 'signin' : 'welcome')}><Text style={styles.link}>‹ Back</Text></Pressable><View style={{ marginTop: 28 }}><VelnoraLogo size={64} /></View><Text style={[styles.brand, { marginTop: 10 }]}>VELNORA</Text><Text style={[styles.authTitle, { color: props.colors.text }]}>{signup ? 'Create your account' : forgot ? 'Reset your password' : 'Welcome back'}</Text><Text style={[styles.subtitle, { color: props.colors.muted }]}>{signup ? 'Start building a clearer view of your finances.' : 'Sign in to continue managing your money.'}</Text>{signup && <AuthField label="FULL NAME" value={props.fullName} onChangeText={props.setFullName} placeholder="Your name" colors={props.colors} icon={<UserRound color={props.colors.muted} size={17} />} />}{<AuthField label="EMAIL" value={props.email} onChangeText={props.setEmail} placeholder="you@example.com" colors={props.colors} icon={<KeyRound color={props.colors.muted} size={17} />} />}{!forgot && <PasswordField label="PASSWORD" value={props.password} onChangeText={props.setPassword} visible={props.showPassword} toggle={() => props.setShowPassword(!props.showPassword)} colors={props.colors} />}{signup && <PasswordField label="CONFIRM PASSWORD" value={props.confirmPassword} onChangeText={props.setConfirmPassword} visible={props.showPassword} toggle={() => props.setShowPassword(!props.showPassword)} colors={props.colors} />}{signup && <Pressable style={styles.termsRow} onPress={() => props.setTermsAccepted(!props.termsAccepted)}><View style={[styles.checkbox, props.termsAccepted && styles.checkboxActive]}>{props.termsAccepted && <Text>✓</Text>}</View><Text style={[styles.caption, { color: props.colors.muted }]}>I accept the terms and privacy policy.</Text></Pressable>}{props.error ? <Text style={styles.errorText}>{props.error}</Text> : null}{props.notice ? <Text style={styles.noticeText}>{props.notice}</Text> : null}<Pressable disabled={props.busy} style={styles.primaryButton} onPress={() => forgot ? props.onForgot() : props.onSubmit(signup ? 'signup' : 'signin')}><Text style={styles.primaryButtonText}>{props.busy ? 'Please wait...' : signup ? 'Create account' : forgot ? 'Check reset options' : 'Sign in'}</Text></Pressable>{!signup && !forgot && <Pressable onPress={() => props.setScreen('forgot')}><Text style={[styles.link, { textAlign: 'center', marginTop: 18 }]}>Forgot password?</Text></Pressable>}{!forgot && <Pressable onPress={() => props.setScreen(signup ? 'signin' : 'signup')}><Text style={[styles.caption, { color: props.colors.muted, textAlign: 'center', marginTop: 22 }]}>{signup ? 'Already have an account? ' : 'New to Velnora? '}<Text style={styles.link}>{signup ? 'Sign in' : 'Create account'}</Text></Text></Pressable>}</ScrollView></KeyboardAvoidingView></SafeAreaView>; }
function AuthField({ label, value, onChangeText, placeholder, icon, colors }: { label: string; value: string; onChangeText: (value: string) => void; placeholder: string; icon: React.ReactNode; colors: Colors }) { return <View style={styles.authField}><Text style={[styles.label, { color: colors.muted }]}>{label}</Text><View style={[styles.authInputWrap, { backgroundColor: colors.card, borderColor: colors.border }]}>{icon}<TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={colors.muted} style={[styles.inputBare, { color: colors.text }]} autoCapitalize="none" /></View></View>; }
function PasswordField({ label, value, onChangeText, visible, toggle, colors }: { label: string; value: string; onChangeText: (value: string) => void; visible: boolean; toggle: () => void; colors: Colors }) { return <View style={styles.authField}><Text style={[styles.label, { color: colors.muted }]}>{label}</Text><View style={[styles.authInputWrap, { backgroundColor: colors.card, borderColor: colors.border }]}><LockKeyhole color={colors.muted} size={17} /><TextInput value={value} onChangeText={onChangeText} placeholder="8+ characters" placeholderTextColor={colors.muted} secureTextEntry={!visible} style={[styles.inputBare, { color: colors.text }]} /><Pressable onPress={toggle}>{visible ? <EyeOff color={colors.muted} size={18} /> : <Eye color={colors.muted} size={18} />}</Pressable></View></View>; }

const buildStyles = () => StyleSheet.create({
  safe: { flex: 1 }, shell: { flex: 1 }, content: { padding: 20, paddingBottom: 150 }, header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }, overline: { ...type.overline }, title: { ...type.display, marginTop: 6 }, iconButton: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', borderWidth: 1 }, avatarText: { ...type.bodyStrong }, heroCard: { borderRadius: radius.xl, padding: 22, marginBottom: 12, overflow: 'hidden', backgroundColor: palette.heroEnd }, flowRow: { flexDirection: 'row', gap: 12 }, flowCard: { flex: 1, minWidth: 0, borderRadius: radius.lg, borderWidth: 1, padding: 14 }, flowCardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 }, flowIcon: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' }, flowCardLabel: { ...type.caption, flex: 1 }, flowCardValue: { ...type.amountMd, marginTop: 10 }, listCard: { borderRadius: radius.lg, borderWidth: 1, paddingHorizontal: 14, overflow: 'hidden' }, homeHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 20 }, headerAvatar: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' }, headerText: { flex: 1, minWidth: 0 }, homeGreeting: { ...type.cardTitle, marginTop: 2 }, headerBtn: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, alignItems: 'center', justifyContent: 'center' }, badge: { position: 'absolute', top: -3, right: -3, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4, backgroundColor: palette.dangerDeep, alignItems: 'center', justifyContent: 'center' }, badgeText: { color: '#FFFFFF', fontSize: 11, lineHeight: 14, fontWeight: '700' }, heroLabel: { ...type.label, color: palette.onNavyMuted }, heroValue: { ...type.amountHero, color: palette.onNavy, marginTop: 8 }, heroHint: { ...type.caption, color: palette.onNavySoft, marginTop: 8 }, heroTitle: { ...type.heading, color: palette.onNavy, marginTop: 14 }, metricRow: { flexDirection: 'row', alignItems: 'stretch', borderTopWidth: 1, borderTopColor: palette.navyBorder, marginTop: 20, paddingTop: 16 }, metric: { flex: 1, minWidth: 0 }, metricDivider: { width: 1, backgroundColor: palette.navyBorder, marginHorizontal: 14 }, metricLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 6 }, metricLabel: { flex: 1, flexShrink: 1 }, metricIcon: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }, metricValue: { ...type.amountMd, marginTop: 8 }, sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 24, marginBottom: 12, minHeight: 28 }, sectionTitle: { ...type.section }, link: { ...type.link, color: palette.accentText, paddingVertical: 6 }, actionRow: { flexDirection: 'row', gap: 12 }, actionButton: { flex: 1, minHeight: 76, borderRadius: radius.lg, borderWidth: 1, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12, overflow: 'hidden' }, actionIcon: { width: 44, height: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' }, actionLabel: { ...type.bodyStrong }, actionHint: { ...type.caption, marginTop: 3 }, card: { borderRadius: radius.lg, borderWidth: 1, padding: 18 }, cardTitle: { ...type.cardTitle }, flowValue: { ...type.amountLg, marginTop: 8 }, flowHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }, flowMonth: { ...type.captionStrong }, flowSplit: { flexDirection: 'row', gap: 16, marginTop: 12 }, flowItem: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 }, flowDot: { width: 8, height: 8, borderRadius: 4 }, flowItemLabel: { ...type.caption }, flowItemValue: { ...type.amountSm, marginLeft: 'auto' }, progressTrack: { height: 8, borderRadius: 4, backgroundColor: palette.border, overflow: 'hidden', marginTop: 14 }, progressFill: { height: '100%', borderRadius: 4 }, caption: { ...type.caption, marginTop: 7 }, transactionRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, borderBottomWidth: 1 }, transactionIcon: { width: 44, height: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', marginRight: 12 }, rowBody: { flex: 1 }, rowTitle: { ...type.cardTitle }, rowAmount: { ...type.amountSm }, sourceLabel: { ...type.label, marginTop: 3, textTransform: 'uppercase' }, searchBox: { minHeight: 48, borderRadius: 14, borderWidth: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 9 }, searchInput: { ...type.body, flex: 1 }, filterRow: { flexDirection: 'row', gap: 8, marginTop: 14 }, filterChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: isDarkScheme() ? palette.darkElevated : palette.canvas2 }, filterChipActive: { backgroundColor: palette.emeraldSoft }, filterChipText: { ...type.chip }, categoryScroll: { marginTop: 10 }, chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 18, marginRight: 7, backgroundColor: isDarkScheme() ? palette.darkElevated : palette.canvas2 }, chipActive: { backgroundColor: palette.emeraldSoft }, chipText: { ...type.chip }, chart: { height: 160, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center', gap: 18, paddingTop: 16 }, chartBar: { width: 46, borderRadius: 10 }, legend: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12 }, budgetRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 15 }, emptyCard: { borderRadius: 18, borderWidth: 1, padding: 20, alignItems: 'flex-start', gap: 7 }, emptyTitle: { ...type.cardTitle }, personRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 13, borderBottomWidth: 1 }, personAvatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: palette.emeraldSoft, alignItems: 'center', justifyContent: 'center', marginRight: 12 }, personInitial: { ...type.cardTitle, color: palette.accentText }, profileCard: { borderRadius: 20, borderWidth: 1, alignItems: 'center', padding: 22 }, profileAvatar: { width: 64, height: 64, borderRadius: 32, backgroundColor: palette.emeraldSoft, alignItems: 'center', justifyContent: 'center' }, profileInitial: { color: palette.accentText, fontSize: 26, fontWeight: '700' }, profileName: { ...type.heading, marginTop: 12 }, settingRow: { minHeight: 66, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, gap: 12 }, settingIcon: { width: 34, height: 34, borderRadius: 11, backgroundColor: palette.emeraldSoft, alignItems: 'center', justifyContent: 'center' }, logoutButton: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 20 }, fab: { position: 'absolute', right: 20, bottom: layout.navHeight + 16, width: 54, height: 54, borderRadius: 27, ...elevation.fab, backgroundColor: palette.emerald, alignItems: 'center', justifyContent: 'center' }, nav: { position: 'absolute', left: 0, right: 0, bottom: 0, height: layout.navHeight, borderTopWidth: 1, flexDirection: 'row', justifyContent: 'space-around', paddingTop: 7 }, navItem: { flex: 1, alignItems: 'center', gap: 3 }, navPillWrap: { width: layout.navPill.width, height: layout.navPill.height, alignItems: 'center', justifyContent: 'center' }, navPill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: layout.navPill.height / 2 }, navLabel: { ...type.nav }, modalBackdrop: { flex: 1, backgroundColor: '#00000066', justifyContent: 'flex-end' }, modal: { borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 22, paddingBottom: 34 }, modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }, modalTitle: { ...type.heading }, label: { ...type.label, marginTop: 15, marginBottom: 7 }, segment: { flexDirection: 'row', gap: 10 }, segmentItem: { flex: 1, minHeight: 45, borderRadius: 12, backgroundColor: isDarkScheme() ? palette.darkElevated : palette.canvas2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 }, segmentActive: { backgroundColor: palette.emeraldSoft }, segmentText: { ...type.link }, input: { ...type.body, minHeight: 48, borderWidth: 1, borderRadius: 12, paddingHorizontal: 13 }, amountBox: { minHeight: 60, borderRadius: 14, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 8 }, amountSymbol: { ...type.amountLg }, amountInput: { ...type.amountInput, flex: 1, paddingVertical: 8 }, scanLink: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 18, paddingVertical: 12, borderRadius: 13, borderWidth: 1, borderStyle: 'dashed' }, primaryButton: { minHeight: 52, borderRadius: 14, backgroundColor: palette.emerald, alignItems: 'center', justifyContent: 'center', marginTop: 22 }, primaryButtonText: { ...type.button, color: readableOn(palette.emerald) }, outlineButton: { alignSelf: 'flex-start', paddingHorizontal: 15, paddingVertical: 10, borderRadius: 12, borderWidth: 1, borderColor: palette.emerald, marginTop: 18 }, outlineButtonText: { ...type.button, color: palette.accentText }, loading: { flex: 1, alignItems: 'center', justifyContent: 'center' }, brand: { color: palette.accentText, fontSize: 13, fontWeight: '700', letterSpacing: 3 }, welcome: { flexGrow: 1, justifyContent: 'center', padding: 26 }, logoMark: { width: 62, height: 62, borderRadius: 20, backgroundColor: palette.navyBorder, alignItems: 'center', justifyContent: 'center', marginBottom: 20 }, welcomeTitle: { color: '#FFFFFF', fontSize: 40, lineHeight: 46, fontWeight: '700', marginTop: 30 }, welcomeDescription: { color: palette.onNavySoft, fontSize: 17, lineHeight: 25, marginTop: 18 }, productDescriptor: { color: palette.accentText, fontSize: 12, fontWeight: '700', marginTop: 22 }, secondaryButton: { minHeight: 52, borderRadius: 13, borderWidth: 1, borderColor: palette.navyBorder, alignItems: 'center', justifyContent: 'center', marginTop: 12 }, secondaryButtonText: { ...type.button, color: '#FFFFFF' }, formScreen: { padding: 24, paddingBottom: 50 }, authTitle: { ...type.title, marginTop: 18 }, subtitle: { ...type.body, marginBottom: 12 }, authField: { marginTop: 17 }, authInputWrap: { minHeight: 50, borderRadius: 12, borderWidth: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 13, gap: 9 }, inputBare: { ...type.body, flex: 1, paddingVertical: 12 }, termsRow: { flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 18 }, checkbox: { width: 21, height: 21, borderRadius: 6, borderWidth: 1, borderColor: palette.muted, alignItems: 'center', justifyContent: 'center' }, checkboxActive: { backgroundColor: palette.emerald, borderColor: palette.emerald }, errorText: { ...type.caption, color: palette.expenseText, marginTop: 15 }, noticeText: { ...type.caption, color: palette.warning, marginTop: 15 },
});

let styles = buildStyles();
let stylesAccent: string = 'emerald';
