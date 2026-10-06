// ── CONTRACT TYPES — snake_case WAJIB, sesuai CONTRACT.md ─────────────────────

export type TxType = 'income' | 'expense';
export type Period = 'today' | 'week' | 'month';

export interface Transaction {
  id: number;
  user_id: string;
  type: TxType;
  amount: number;       // integer Rupiah, 1–999_999_999
  category: string;     // lowercase
  note: string;         // max 100 char
  wallet_id?: number | null;
  wallet_name?: string | null;
  tags?: string[];
  created_at: string;   // "YYYY-MM-DD HH:MM:SS"
}

export interface Budget {
  id: number;
  user_id: string;
  category: string;
  amount: number;
  month: string;        // "YYYY-MM"
  created_at: string;
  // GET only — injected by backend
  spent?: number;
  percentage?: number;
  remaining?: number;
}

export interface CategorySummary {
  type: TxType;
  category: string;
  total: number;
  count: number;
}

export interface BudgetAlert {
  category: string;
  spent: number;
  budget: number;
  percentage: number;
}

export interface Summary {
  period: Period;
  income: number;
  expense: number;
  balance: number;
  by_category: CategorySummary[];
}

export interface TransactionListResponse {
  data: Transaction[];
  total: number;
  limit: number;
  offset: number;
}

export interface TransactionCreateResponse {
  data: Transaction;
  budgetAlert: BudgetAlert | null;
}

export interface BudgetListResponse {
  month: string;
  data: Budget[];
}

export interface CategoriesResponse {
  expense: string[];
  income: string[];
}

// ── Account & insights (GET /api/me, GET /api/insights) ─────────────────────

export type Tier = 'trial' | 'free' | string;

export interface Profile {
  monthly_income: number | null;
  payday: number | null;        // 1–31
  style: 'santai' | 'formal' | 'singkat' | null;
  emoji: boolean | null;
  language: 'auto' | 'id' | 'jawa' | 'sunda' | 'en' | 'campur' | null;
  persona: 'teman' | 'konsultan' | 'coach' | null;
  reminder_time: string | null; // "HH:MM", "off", or null (admin default)
  reminder2_time: string | null; // second (midday) reminder: "HH:MM", "off", or null (admin default, off unless set)
  smart_nudge: boolean;
}

// ── Personal categories (GET /api/me/categories) ──────────────────────────────

export interface UserCategory {
  name: string;
  emoji: string;
  custom: boolean;
  hidden: boolean;
}

export interface UserCategoriesResponse {
  expense: UserCategory[];
  income: UserCategory[];
  keywords: { keyword: string; type: TxType; category: string }[];
}

// ── Wallets (GET /api/wallets) ────────────────────────────────────────────────

export type WalletKind = 'cash' | 'bank' | 'ewallet' | 'qris' | 'credit' | 'other';

export interface Wallet {
  id: number;
  name: string;
  kind: WalletKind;
  balance: number;
  opening_balance?: number;
  is_default: boolean;
  archived?: boolean;
}

export interface WalletsResponse {
  data: Wallet[];
  kinds: WalletKind[];
  total: number;        // all-time "Sisa saldo"
  unassigned: number;   // part of total not in any wallet
}

export interface Subscription {
  tier: Tier;
  state: 'active' | 'free';
  plan_name: string;
  expires_at: string | null;    // "YYYY-MM-DD HH:MM:SS" UTC; null = no expiry
  days_left: number | null;
  ai_daily_limit: number;
  ai_used_today: number;
  receipt_monthly_limit: number;
  receipts_used_this_month: number;
}

export interface MeResponse {
  user: { user_id: string; first_name: string; nickname: string; display_name: string };
  profile: Profile;
  subscription: Subscription;
}

export interface TodayAllowance {
  allowance: number;
  spent: number;
  left: number;                 // negative = over today's allowance
  days_left: number;
  next_payday: string | null;   // "YYYY-MM-DD"; null = cycle ends at month end
  cycle_remaining: number;
  reserved_bills: number;       // unpaid bills due before payday, set aside first
}

export interface Debt {
  id: number;
  person: string;
  direction: 'owed_to_me' | 'i_owe';
  amount: number;
  note: string;
  settled: boolean;
}

export interface DebtSummary {
  owed_to_me: number;
  i_owe: number;
  people: { person: string; owed_to_me: number; i_owe: number }[];
}

export interface Challenge {
  id: number;
  kind: 'no_spend' | 'limit' | 'streak';
  category: string | null;
  target_amount: number | null;
  start_date: string;
  end_date: string;
  status: 'active' | 'done' | 'failed' | 'cancelled';
  days_total: number;
  days_elapsed: number;
  spent: number;
  logged_days: number;
}

export interface BudgetSuggestion {
  category: string;
  average: number;
  suggested: number;
  current: number | null;
}

export interface Bill {
  id: number;
  name: string;
  amount: number;
  type: TxType;
  category: string;
  day_of_month: number;
  wallet_id: number | null;
  last_paid_month: string | null;
  due_date: string;             // next unpaid due date "YYYY-MM-DD"
  month: string;                // "YYYY-MM" that due date belongs to
  days_until: number;           // negative = overdue
  paid_this_month: boolean;
}

export interface BudgetWatch {
  category: string;
  amount: number;
  spent: number;
  remaining: number;
  percentage: number;
}

export interface GoalInsight {
  id: number;
  name: string;
  target_amount: number;
  saved_amount: number;
  target_date: string | null;   // "YYYY-MM" or "YYYY-MM-DD"
  left: number;
  progress_pct: number;
  months_left: number | null;
  per_month: number | null;
}

export interface Tip {
  kind: 'warning' | 'good' | 'info';
  text: string;
}

export interface InsightsResponse {
  today: string;
  balance: { income: number; expense: number; opening: number; net: number };  // all time
  wallets: Wallet[];
  bills: Bill[];
  debts: DebtSummary;
  challenges: Challenge[];
  month_to_date: { income: number; expense: number; count: number; net: number };
  previous_month_same_period: { expense: number };
  expense_change_pct: number | null;
  avg_daily_expense: number;
  busiest_weekday: string | null;
  goals: GoalInsight[];
  today_allowance: TodayAllowance | null;
  budget_watch: BudgetWatch | null;
  tips: Tip[];
}

export interface ApiError {
  error: string;
}

// ── Laporan (GET /api/export/report) ─────────────────────────────────────────

export type ReportPeriodKey = 'this_month' | 'last_month' | 'last_3_months' | 'this_year' | 'all';

export interface ReportResponse {
  period: { key: ReportPeriodKey | 'custom'; from: string | null; to: string | null; label: string; file_name: string };
  periods: Array<{ key: ReportPeriodKey; label: string }>;
  summary: {
    count: number;
    income: number;
    expense: number;
    net: number;
    first_date: string | null;
    last_date: string | null;
    by_category: Array<{ type: TxType; category: string; total: number; count: number }>;
    by_month: Array<{ month: string; income: number; expense: number }>;
  };
  balance: { opening: number; closing: number };
  data: Array<{
    id: number; date: string; created_at: string; type: TxType; category: string; note: string | null;
    wallet_name: string | null; tags: string[]; amount: number;
  }>;
}

export interface ReportLink { url: string; file_name: string; expires_at: string }

// ── UI State helpers ─────────────────────────────────────────────────────────

export type LoadingState = 'idle' | 'loading' | 'success' | 'error';

export interface AsyncState<T> {
  state: LoadingState;
  data: T | null;
  error: string | null;
}
