import { Router } from 'express';
import requireTelegramAuth from '../middleware/auth.js';
import apiLimiter from '../middleware/rateLimit.js';
import {
  listWallets, getWallet, createWallet, updateWallet, transferBetweenWallets, WALLET_KINDS
} from '../../db/wallets.js';
import { getBalance } from '../../db/transactions.js';

const router = Router();

router.use(requireTelegramAuth);
router.use(apiLimiter);

const isMoney = (v) => Number.isInteger(v) && Math.abs(v) <= 999999999999;

function walletsResponse(userId) {
  const data = listWallets(userId);
  const total = getBalance(userId).net;
  const inWallets = data.reduce((sum, w) => sum + w.balance, 0);
  // Money recorded without a wallet (before wallets were set up, or left unassigned).
  return { data, kinds: WALLET_KINDS, total, unassigned: total - inWallets };
}

/**
 * GET /api/wallets — active wallets with balances, the all-time total and the part not in any wallet.
 */
router.get('/', (req, res, next) => {
  try {
    res.json(walletsResponse(req.user.user_id));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/wallets — { name, kind?, balance? } where balance is what is in it right now.
 */
router.post('/', (req, res, next) => {
  try {
    const { name, kind = null, balance = 0, is_default = false } = req.body || {};
    if (!isMoney(balance)) return res.status(400).json({ error: 'balance harus bilangan bulat rupiah' });
    if (kind !== null && !WALLET_KINDS.includes(kind)) return res.status(400).json({ error: `kind harus salah satu dari: ${WALLET_KINDS.join(', ')}` });
    const result = createWallet(req.user.user_id, { name, kind, balance, is_default: is_default === true });
    if (result.error) return res.status(400).json({ error: result.error });
    res.status(201).json({ wallet: result.wallet, ...walletsResponse(req.user.user_id) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/wallets/transfer — { from_wallet_id, to_wallet_id, amount, note? }
 */
router.post('/transfer', (req, res, next) => {
  try {
    const { from_wallet_id, to_wallet_id, amount, note = '' } = req.body || {};
    const result = transferBetweenWallets(req.user.user_id, { from_wallet_id, to_wallet_id, amount, note });
    if (result.error) return res.status(400).json({ error: result.error });
    res.status(201).json({ transfer: result.transfer, ...walletsResponse(req.user.user_id) });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/wallets/:id — { name?, kind?, balance?, is_default?, archived? }
 */
router.patch('/:id', (req, res, next) => {
  try {
    const userId = req.user.user_id;
    if (!getWallet(userId, req.params.id)) return res.status(404).json({ error: 'Dompet tidak ditemukan' });
    const body = req.body || {};
    const changes = {};
    for (const key of ['name', 'kind', 'balance', 'is_default', 'archived']) if (key in body) changes[key] = body[key];
    if ('balance' in changes && !isMoney(changes.balance)) return res.status(400).json({ error: 'balance harus bilangan bulat rupiah' });
    for (const key of ['is_default', 'archived']) {
      if (key in changes && typeof changes[key] !== 'boolean') return res.status(400).json({ error: `${key} harus true/false` });
    }
    const result = updateWallet(userId, req.params.id, changes);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ wallet: result.wallet, ...walletsResponse(userId) });
  } catch (err) {
    next(err);
  }
});

export default router;
