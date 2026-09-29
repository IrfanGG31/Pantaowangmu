# Finance Bot — Telegram Mini App + Bot

Aplikasi pencatatan keuangan pribadi via Telegram Bot + Mini App.

## Stack
- **Backend API**: Node.js + Express
- **Database**: JSON file store (tidak butuh native build tools)
- **Bot**: node-telegram-bot-api
- **Mini App**: SvelteKit (static build)
- **Scheduler**: node-cron (reminder, weekly summary, budget alerts)

---

## 🚀 Quick Start

### 1. Setup Bot Token

Edit file `.env`:
```
BOT_TOKEN=TOKEN_DARI_BOTFATHER
WEBAPP_URL=http://localhost:5173  (atau URL deploy mini app)
PORT=3000
```

### 2. Jalankan API Server
```bash
npm start          # production
npm run dev        # development (nodemon)
```

### 3. Jalankan Bot
```bash
npm run bot        # production
npm run dev:bot    # development (nodemon)
```

### 4. Jalankan Mini App (development)
```bash
cd webapp
npm run dev        # http://localhost:5173
```

### 5. Build Mini App untuk Deploy
```bash
cd webapp
npm run build      # output di webapp/build/
```

---

## 📦 Struktur Project

```
finance-bot/
├── api/
│   ├── server.js          # Express API server (port 3000)
│   ├── routes/
│   │   ├── auth.js        # Telegram initData validation
│   │   ├── transactions.js # CRUD transaksi
│   │   └── budgets.js     # CRUD budget
│   └── db/
│       ├── schema.sql     # (referensi schema)
│       └── connection.js  # Pure JS JSON file database
├── bot/
│   ├── index.js           # Bot entry point
│   ├── commands.js        # Handler semua commands
│   └── scheduler.js       # Cron jobs
├── webapp/                # SvelteKit mini app
│   ├── src/routes/
│   │   ├── +page.svelte   # Dashboard
│   │   ├── add/           # Form catat transaksi
│   │   ├── list/          # Riwayat transaksi
│   │   ├── stats/         # Statistik & chart
│   │   └── budget/        # Budget management
│   └── build/             # Static output (deploy ke Vercel/Netlify)
├── data/
│   └── finance.db.json    # Database file (auto-created)
└── .env
```

---

## 🤖 Bot Commands

| Command | Fungsi |
|---|---|
| `/start` | Welcome + tombol buka mini app |
| `/catat 25000 makan siang padang` | Catat transaksi |
| `/hari` | Ringkasan hari ini |
| `/minggu` | Ringkasan 7 hari terakhir |
| `/bulan` | Ringkasan bulan ini |
| `/budget makan 1000000` | Set budget kategori |
| `/hapus` | Preview hapus transaksi terakhir |
| `/konfirmhapus` | Konfirmasi hapus |
| `/export` | Export CSV ke chat |
| `/help` | Semua perintah |

---

## 📁 Kategori

**Expense:** makan, transport, belanja, tagihan, hiburan, kesehatan, pendidikan, lainnya  
**Income:** gaji, bonus, freelance, investasi, lainnya

---

## ⏰ Otomasi (Cron Jobs)

| Job | Waktu |
|---|---|
| Reminder harian | 21:00 WIB |
| Budget alerts | 20:00 WIB |
| Weekly summary | Senin 09:00 WIB |

---

## 🌐 Deploy

### Backend (Railway/Render/VPS)
1. Push ke GitHub
2. Connect ke Railway/Render
3. Set env vars: `BOT_TOKEN`, `WEBAPP_URL`, `PORT`

### Mini App (Vercel/Netlify)
1. `cd webapp && npm run build`
2. Deploy folder `webapp/build/` ke Vercel
3. Update `WEBAPP_URL` di backend `.env`

### Setup Mini App di BotFather
```
/mybots → pilih bot → Bot Settings → Menu Button → URL webapp
```

---

## 🔒 Keamanan

- Telegram initData divalidasi HMAC-SHA256 di setiap request
- Rate limiting: 60 req/menit per IP
- Input sanitized: max 100 char, strip special chars
- Amount validation: 1 s/d 999.999.999
- Dev mode bypass via `X-Dev-User-Id` header (disabled di production)
