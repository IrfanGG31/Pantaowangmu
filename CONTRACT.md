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
- Columns: `id, date, time, month, weekday, type, category, amount, signed_amount, note, created_at_utc, wallet`.
  `date`/`time`/`month`/`weekday` are local to `TIMEZONE` (default Asia/Jakarta); `signed_amount` is negative for expenses;
  `created_at_utc` is the stored UTC value; `wallet` is the wallet name (empty when none). Text cells starting with `= + - @` are prefixed with `'` so spreadsheets don't run them as formulas.

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
  balance: { income: number; expense: number; net: number };  // sepanjang waktu: semua pemasukan − pengeluaran ("Sisa saldo")
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

### Personalisasi: kategori, dompet, bahasa & persona

#### `GET /me/categories`
`{ expense: UserCategory[]; income: UserCategory[]; keywords: { keyword, type, category }[] }` dengan
`UserCategory = { name: string; emoji: string; custom: boolean; hidden: boolean }` (bawaan + buatan pengguna).

#### `POST /me/categories` `{ type?: 'expense'|'income', name, emoji? }` → 201 `{ data }`
Nama 1–30 huruf/angka/spasi/"-", disimpan lowercase; maks 30 kategori buatan. Nama bawaan = munculkan lagi / ganti emoji.

#### `DELETE /me/categories/:type/:name` → `{ removed: 'custom'|'hidden' }`
Kategori buatan dihapus (transaksi lama tetap berlabel itu); kategori bawaan disembunyikan dari pilihan. "lainnya" tidak bisa dihapus.

`POST /transactions` dan `POST /budgets` menerima kategori bawaan **atau** buatan pengguna (budget: pengeluaran saja);
kategori yang tidak ada → 400.

#### Dompet (opsional)
- `GET /wallets` → `{ data: Wallet[]; kinds; total; unassigned }`; `Wallet = { id, name, kind, balance, opening_balance, is_default, archived }`,
  `kind` ∈ `cash|bank|ewallet|qris|credit|other`. `balance` = saldo awal + pemasukan − pengeluaran di dompet itu ± transfer.
  `total` = Sisa saldo semua; `unassigned` = bagian yang tidak tercatat di dompet mana pun.
- `POST /wallets` `{ name, kind?, balance? }` → 201 `{ wallet, ...GET }` (`balance` = saldo sekarang; dompet pertama jadi utama).
- `PATCH /wallets/:id` `{ name?, kind?, balance?, is_default?, archived? }` → `{ wallet, ...GET }` (`balance` menyamakan saldo sekarang).
- `POST /wallets/transfer` `{ from_wallet_id, to_wallet_id, amount, note? }` → 201 `{ transfer, ...GET }`. Bukan pemasukan/pengeluaran.
- `POST /transactions` menerima `wallet_id` (angka = dompet itu, `null` = tanpa dompet, tidak dikirim = dompet utama bila ada).
- `PATCH /transactions/:id/wallet` `{ wallet_id: number|null }` → `{ data: Transaction }`.
- `Transaction` sekarang punya `wallet_id` dan `wallet_name`.
- `GET /insights` menambah `wallets` dan `wallet_spend_month`; `balance.net` = saldo awal dompet + pemasukan − pengeluaran.

#### Bahasa & persona
`PATCH /me/profile` juga menerima `language` (`auto|id|jawa|sunda|en|campur`) dan `persona` (`teman|konsultan|coach`); `null` = default.

### Tagihan rutin & pengingat

- `GET /bills` → `{ data: Bill[] }`; `Bill = { id, name, amount, type, category, day_of_month, wallet_id, last_paid_month,
  due_date, month, days_until, paid_this_month }` (`due_date` = jatuh tempo berikutnya yang belum dibayar; tanggal 31 di bulan
  pendek jadi tanggal terakhir; `days_until` negatif = lewat).
- `POST /bills` `{ name, amount, day_of_month, type?, category?, wallet_id? }` → 201 `{ data }` (nama sama = diperbarui, 200).
  Jatuh tempo bulan ini yang sudah lewat saat dibuat dianggap sudah beres bulan ini.
- `PATCH /bills/:id` `{ name?, amount?, day_of_month?, wallet_id? }`, `DELETE /bills/:id`.
- `POST /bills/:id/pay` `{ month?: "YYYY-MM", record?: boolean }` → `{ data, transaction }`: tandai lunas bulan itu dan catat
  transaksinya (`record: false` = lewati bulan ini). Bulan yang sudah ditandai → 409 (aman dari dobel ketuk).
- `GET /insights`: `bills`, dan `today_allowance.reserved_bills` (tagihan belum dibayar sebelum gajian, termasuk yang lewat,
  disisihkan dulu dari jatah harian).
- `PATCH /me/profile` menerima `reminder_time` dan `reminder2_time` (pengingat siang): `"HH:MM"` | `"off"` | `null` = default dari admin; serta `smart_nudge` (boolean).

### Tag, utang-piutang, saran budget, tantangan

- Tag: `POST /transactions` menerima `tags: string[]` (maks 5; huruf/angka/"-"/"_", tanpa "#", disimpan lowercase).
  `Transaction.tags: string[]`. `GET /transactions?tag=bali`. `GET /transactions/tags?month=YYYY-MM` → `{ data: [{ tag, expense, income, count }] }`.
- Utang-piutang (buku terpisah, **tidak mengubah Sisa saldo**):
  `GET /debts` → `{ data: Debt[], summary: { owed_to_me, i_owe, people[] } }`; `Debt = { id, person, direction: 'owed_to_me'|'i_owe', amount, note, settled }`.
  `POST /debts` `{ person, direction, amount, note? }`; `POST /debts/:id/settle` (409 bila sudah lunas);
  `POST /debts/split` `{ total, people, names?, category?, note?, wallet_id? }` → bagian pengguna dicatat sebagai pengeluaran,
  sisanya jadi piutang (sisa pembulatan ikut bagian pengguna) → `{ transaction, data, summary }`.
- Saran budget: `GET /budgets/suggestions` → `{ months, data: [{ category, average, suggested, current }] }` (rata-rata 3 bulan
  penuh terakhir yang ada pengeluarannya, dihemat 10%, dibulatkan ke Rp 10.000; rata-rata < Rp 20.000 dilewati).
  `POST /budgets/suggestions/apply` `{ categories?: string[] }` → budget bulan ini.
- Tantangan: `GET /challenges` → `{ data: Challenge[] }` (aktif + yang selesai ≤ 7 hari); `Challenge = { id, kind: 'no_spend'|'limit'|'streak',
  category, target_amount, start_date, end_date, status: 'active'|'done'|'failed', days_total, days_elapsed, spent, logged_days }`.
  `POST /challenges` `{ kind, category?, days? (1–90), target_amount? (wajib untuk limit) }` (maks 3 aktif); `DELETE /challenges/:id`.
- `GET /insights` menambah `debts` (summary) dan `challenges`.

---

### Misc

#### `GET /categories`
Response:
```ts
{ expense: string[]; income: string[] }
```

#### `GET /health`
Response: `{ status: 'ok'; timestamp: string }`

#### `GET /app-config` (tanpa auth)
Pengaturan publik untuk PWA di luar Telegram. Response: `{ bot_username: string | null; bot_url: string | null }`
(`bot_url` = `https://t.me/<bot_username>`; `null` bila bot belum tersambung).

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
| `GET /api/admin/backups` | `{ remote_configured, keep, schedule, timezone, last: { at, ok, name, size, reason, remote, error } \| null, data: [{ name, size, created_at }] }` |
| `POST /api/admin/backups` `{}` | Backup sekarang → 201 `{ status, ...GET /backups }`; 500 bila gagal. Dicatat di audit log. |
| `GET /api/admin/backups/:name` | Unduh `finance-YYYYMMDD-HHMMSS.db.gz` (gzip SQLite). Nama lain → 404. Dicatat di audit log. |
| `GET /api/admin/ideas?days=1..365&status=` | Ide dari pengguna (tanpa identitas): `{ statuses, ai_configured, ideas: [{ topic, count, users, last_at, examples[], status, note }], unparsed: [{ id, summary, count, users, last_at }] }` |
| `PATCH /api/admin/ideas/:topic` | `{ status?: "new"\|"planned"\|"done"\|"ignored", note? }` → `{ topic, status, note }`. Dicatat di audit log. |
| `POST /api/admin/ideas/cluster` `{}` | AI mengelompokkan pesan yang belum dipahami bot menjadi ide → `{ ...GET /ideas, clustered, idea_count }`; 503 AI belum dikonfigurasi; 502 AI gagal. Dicatat di audit log. |
| `GET /api/admin/analytics` | `{ funnel: [{ step, label, count, pct_of_start, pct_of_previous, separate? }], retention: [{ week, users, recorded_pct, d1, d7, d30 }], at_risk: [{ user_id, name, username, last_tx_at, days_quiet, active_days_before, state, tier }] }`. Funnel bertingkat: started → recorded → habit (3+ hari) → active7; `paid` terpisah. Retensi D-N = % yang masih mencatat setelah hari ke-N (null bila belum ada yang seumur itu). Tanpa nominal/catatan. |
| `GET /api/admin/ai-health?days=1..90` (default 7) | `{ days, status: "ok"\|"warning"\|"critical"\|"idle", alerts: [{ level, model, kind, message }], models: [{ model, kind, calls, ok, success_pct, avg_latency_ms, p95_latency_ms, calls_last_hour, failed_last_hour, last_ok_at, last_error, last_error_at, cost }], daily: [{ date, calls, failed }], last_ok_at }` |
| `GET /api/admin/broadcasts` | `{ bot_ready, running_id, max_length, segments: [{ id, label, count }], data: [{ id, admin_email, segment, text, with_button, total, sent, failed, blocked, status, created_at, finished_at }] }`. Segmen: `all`, `active`, `trial`, `paid`, `free`, `at_risk` (pengguna yang diblokir admin tidak pernah dikirimi). `{nama}` di teks diganti nama tiap pengguna |
| `POST /api/admin/broadcasts` `{ text, segment?, with_button? }` | Kirim di latar belakang (~25 pesan/detik) → 202 `{ broadcast, ...GET }`. 409 bila masih ada yang berjalan, 503 bila bot mati. Teks biasa, maks. 3500 karakter. Hanya jumlah yang disimpan, bukan daftar penerima. Dicatat di audit log. |
| `POST /api/admin/broadcasts/test` `{ text, with_button?, user_id }` | Kirim ke satu Telegram user ID (pratinjau). 502 bila gagal/diblokir. Dicatat di audit log. |
| `GET /api/admin/reminders` | `{ time: "HH:MM"\|"off", second: "HH:MM"\|"off", text, builtin_time, stats: { users, custom, off, custom2, off2, smart } }` (`second` = pengingat ke-2/siang, default `"off"`) |
| `PUT /api/admin/reminders` `{ time?, second?, text? }` | Jam default pengingat harian dan pengingat ke-2 (atau `"off"`; keduanya harus berbeda) dan teks opsional (`{nama}` = nama pengguna, maks. 600). Berlaku untuk pengguna tanpa jam sendiri. Dicatat di audit log. |
| `POST /api/admin/reminders/reset-all` `{}` | Pengguna yang memilih jam sendiri kembali ke default (yang mematikan tetap mati) → `{ reset, ...GET }`. Dicatat di audit log. |
| `GET /api/admin/audit?limit=` | `{ data: [{ admin_email, action, target_user_id, details, created_at }] }` |
