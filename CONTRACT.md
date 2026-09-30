# CONTRACT.md — Finance Bot API Contract

> Single source of truth antara Backend dan Frontend.  
> Jangan ubah tanpa sync kedua pihak.

---

## Base URL

```
Dev:  http://localhost:3001/api
Prod: $VITE_API_URL/api
```

## Authentication

Setiap request **wajib** kirim salah satu header:

| Mode | Header | Value |
|------|--------|-------|
| Production (Telegram) | `Authorization` | `tma <initData>` |
| Development bypass | `X-Dev-User-Id` | `<userId string>` |

---

## Endpoints

### Transactions

#### `GET /transactions`
Query params: `limit` (max 100, default 20), `offset`, `type` (`income`|`expense`), `month` (`YYYY-MM`), `date` (`YYYY-MM-DD`)

Response:
```ts
{
  data: Transaction[];
  total: number;
  limit: number;
  offset: number;
}
```

#### `GET /transactions/summary?period=today|week|month`
Response:
```ts
{
  period: 'today' | 'week' | 'month';
  income: number;
  expense: number;
  balance: number;
  by_category: CategorySummary[];
}
```

#### `POST /transactions`
Body:
```ts
{ type: 'income'|'expense'; amount: number; category: string; note?: string }
```
Response:
```ts
{ data: Transaction; budgetAlert: BudgetAlert | null }
```
Status: 201

#### `DELETE /transactions/last`
Response: `{ data: Transaction; message: string }`

#### `DELETE /transactions/:id`
Response: `{ data: Transaction; message: string }`

#### `GET /transactions/export?delimiter=semicolon|comma`
Returns: CSV file download (Content-Disposition: attachment), UTF-8 with BOM, CRLF line endings, oldest first.

- `delimiter` defaults to `semicolon` (Excel with Indonesian regional settings); use `comma` for pandas/BI tools.
- Columns: `id, date, time, month, weekday, type, category, amount, signed_amount, note, created_at_utc`.
  `date`/`time`/`month`/`weekday` are local to `TIMEZONE` (default Asia/Jakarta); `signed_amount` is negative for expenses;
  `created_at_utc` is the stored UTC value. Text cells starting with `= + - @` are prefixed with `'` so spreadsheets don't run them as formulas.

---

### Budgets

#### `GET /budgets?month=YYYY-MM`
Response:
```ts
{ month: string; data: Budget[] }
```

#### `POST /budgets`
Body:
```ts
{ category: string; amount: number; month?: string }
```
Response: `{ data: Budget }` — Status: 201

#### `DELETE /budgets/:id`
Response: `{ data: Budget; message: string }`

---

### Account & insights (Beranda)

#### `GET /me`
Response:
```ts
{
  user: { user_id: string; first_name: string; nickname: string; display_name: string };  // display_name = nickname || first_name
  profile: { monthly_income: number | null; payday: number | null; style: 'santai'|'formal'|'singkat'|null; emoji: boolean | null };
  subscription: {
    tier: string;              // 'trial' | 'free' | id paket (mis. 'pro')
    state: 'active' | 'free';
    plan_name: string;         // 'Trial' | 'Gratis' | nama paket
    expires_at: string | null; // UTC "YYYY-MM-DD HH:MM:SS"; null = tanpa batas / sudah Gratis
    days_left: number | null;  // dibulatkan ke atas
    ai_daily_limit: number; ai_used_today: number;
    receipt_monthly_limit: number; receipts_used_this_month: number;
  };
}
```

#### `PATCH /me/profile`
Body (minimal satu field): `{ monthly_income?: number | null; payday?: number | null }`.
`monthly_income` bilangan bulat rupiah 1..999_999_999_999, `payday` 1..31, `null` menghapus. Nilai tidak valid → 400.
Response: sama dengan `GET /me`.

#### `GET /insights`
Angka dihitung server (tanpa panggilan AI) pada zona waktu `TIMEZONE`. Response:
```ts
{
  today: string;                                  // "YYYY-MM-DD" lokal
  month_to_date: { income: number; expense: number; count: number; net: number };
  previous_month_same_period: { expense: number };
  expense_change_pct: number | null;              // null bila bulan lalu 0
  avg_daily_expense: number;
  top_increases: CategoryChange[]; top_decreases: CategoryChange[];
  biggest_expense: { amount: number; category: string; note: string; created_at: string } | null;
  busiest_weekday: string | null;
  cycle: { start: string; next_payday: string | null; days_left: number; expense: number; remaining: number | null; safe_per_day: number | null };
  goals: { id: number; name: string; target_amount: number; saved_amount: number; target_date: string | null;
           left: number; progress_pct: number; months_left: number | null; per_month: number | null }[];
  today_allowance: {                              // null bila monthly_income belum diisi
    allowance: number;   // (sisa siklus di awal hari ini) / days_left, dibulatkan ke bawah
    spent: number;       // pengeluaran hari ini
    left: number;        // allowance - spent; negatif = lewat jatah
    days_left: number; next_payday: string | null; cycle_remaining: number;
  } | null;
  budget_watch: { category: string; amount: number; spent: number; remaining: number; percentage: number } | null;  // budget bulan ini dengan persentase tertinggi
  tips: { kind: 'warning' | 'good' | 'info'; text: string }[];  // maksimal 3, berbasis aturan
}
// CategoryChange = { category: string; current: number; before: number; diff: number; pct: number | null }
```

---

### Misc

#### `GET /categories`
Response:
```ts
{ expense: string[]; income: string[] }
```

#### `GET /health`
Response: `{ status: 'ok'; timestamp: string }`

---

## Data Types (snake_case WAJIB)

```ts
interface Transaction {
  id: number;
  user_id: string;
  type: 'income' | 'expense';
  amount: number;           // integer, Rupiah, max 999_999_999
  category: string;         // lowercase
  note: string;             // max 100 chars, bisa kosong
  created_at: string;       // "YYYY-MM-DD HH:MM:SS"
}

interface Budget {
  id: number;
  user_id: string;
  category: string;
  amount: number;
  month: string;            // "YYYY-MM"
  created_at: string;
  spent?: number;           // di-inject backend (GET only)
  percentage?: number;      // spent / amount * 100
  remaining?: number;       // amount - spent
}

interface CategorySummary {
  type: 'income' | 'expense';
  category: string;
  total: number;
  count: number;
}

interface BudgetAlert {
  category: string;
  spent: number;
  budget: number;
  percentage: number;
}

interface Summary {
  period: 'today' | 'week' | 'month';
  income: number;
  expense: number;
  balance: number;
  by_category: CategorySummary[];
}
```

---

## Categories

**Expense:** makan, transport, belanja, tagihan, hiburan, kesehatan, pendidikan, lainnya  
**Income:** gaji, bonus, freelance, investasi, lainnya

---

## Validation Rules

| Field | Rule |
|-------|------|
| `amount` | integer positif, 1 ≤ n ≤ 999_999_999 |
| `category` | lowercase, alphanum + spasi, max 100 char |
| `note` | optional, max 100 char |
| `month` | format `YYYY-MM` |
| `type` | `income` atau `expense` |

---

## Error Response

```ts
{ error: string }
```

HTTP status: 400 (validation), 401 (auth), 403 (akun dinonaktifkan admin, `code: "subscription_inactive"`), 404 (not found), 500 (server)

---

## Admin API (`/api/admin`, bukan untuk Mini App)

Login dengan email + password admin (env `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH`). Sesi berupa cookie HttpOnly `pu_admin`
(Path `/api/admin`, SameSite=Strict, 12 jam). Request yang mengubah data wajib `Content-Type: application/json`.
Respons tidak pernah memuat isi transaksi, catatan, atau rahasia.

| Method & path | Keterangan |
|---|---|
| `POST /api/admin/login` `{ email, password }` | 200 + cookie; 401 salah; 429 terlalu banyak percobaan; 503 admin belum dikonfigurasi |
| `POST /api/admin/logout` | Hapus cookie |
| `GET /api/admin/me` | `{ email, config: { plans: [{ id, ai_daily_limit }], statuses, trial_days } }` |
| `GET /api/admin/overview?days=7..90` | `{ users, ai, transactions, daily[] }` (agregat) |
| `GET /api/admin/users?search=&state=active\|expired\|suspended&plan=trial\|pro&limit=&offset=` | `{ total, data[] }` dengan `state`, `ai_daily_limit_effective`, `ai_calls_today`, `ai_calls_30d`, `ai_tokens_30d`, `tx_count_30d` |
| `PATCH /api/admin/users/:user_id` | Salah satu/lebih: `plan`, `status`, `extend_days` (1..3650) **atau** `plan_expires_at` (`"never"` / tanggal), `ai_daily_limit` (0..10000 / `null` = default paket). Dicatat di audit log. |
| `POST /api/admin/users/:user_id/payments` | `{ plan_id, days?, amount?, note? }`: catat pembayaran manual dan aktifkan paket (default durasi/harga dari paket) |
| `GET /api/admin/plans`, `POST /api/admin/plans`, `PATCH /api/admin/plans/:id` | Paket: `name`, `price` (rupiah, `null` = tanya admin), `period_days`, `ai_daily_limit`, `receipt_monthly_limit`, `active` |
| `GET /api/admin/vouchers`, `POST /api/admin/vouchers`, `PATCH /api/admin/vouchers/:code` | Buat `{ plan_id, count, days?, price?, max_uses?, expires_in_days?, note? }` → `{ codes }`; ubah `{ disabled }` |
| `GET /api/admin/payments?limit=` | Riwayat pembayaran (voucher dan manual) |
| `GET /api/admin/settings`, `PUT /api/admin/settings` | `{ payment_instructions }` (tampil di /langganan) |
| `GET /api/admin/audit?limit=` | `{ data: [{ admin_email, action, target_user_id, details, created_at }] }` |
