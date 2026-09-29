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
