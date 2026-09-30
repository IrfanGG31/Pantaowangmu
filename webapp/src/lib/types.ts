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
  balance: { income: number; expense: number; net: number };  // all time
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

// ── UI State helpers ─────────────────────────────────────────────────────────

export type LoadingState = 'idle' | 'loading' | 'success' | 'error';

export interface AsyncState<T> {
  state: LoadingState;
  data: T | null;
  error: string | null;
}
