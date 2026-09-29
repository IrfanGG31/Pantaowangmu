import Joi from 'joi';

export const EXPENSE_CATEGORIES = [
  'makan',
  'transport',
  'belanja',
  'tagihan',
  'hiburan',
  'kesehatan',
  'pendidikan',
  'lainnya'
];

export const INCOME_CATEGORIES = [
  'gaji',
  'bonus',
  'freelance',
  'investasi',
  'lainnya'
];

export const ALL_CATEGORIES = [...new Set([...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES])];

// Joi schemas
const transactionSchema = Joi.object({
  type: Joi.string().valid('income', 'expense').required().messages({
    'any.required': 'Type harus diisi',
    'any.only': 'Type harus income atau expense'
  }),
  amount: Joi.number().integer().min(1).max(999999999).required().messages({
    'any.required': 'Jumlah amount harus diisi',
    'number.base': 'Amount harus berupa angka',
    'number.integer': 'Amount harus berupa bilangan bulat',
    'number.min': 'Amount minimum Rp 1',
    'number.max': 'Amount maksimum Rp 999.999.999'
  }),
  category: Joi.string().trim().lowercase().min(1).max(50).valid(...ALL_CATEGORIES).required().messages({
    'any.required': 'Kategori harus diisi',
    'any.only': `Kategori harus salah satu dari: ${ALL_CATEGORIES.join(', ')}`
  }),
  note: Joi.string().trim().max(200).allow('', null).default('').messages({
    'string.max': 'Catatan maksimal 200 karakter'
  })
});

const budgetSchema = Joi.object({
  category: Joi.string().trim().lowercase().min(1).max(50).valid(...EXPENSE_CATEGORIES).required().messages({
    'any.required': 'Kategori budget harus diisi',
    'any.only': `Budget hanya untuk kategori pengeluaran: ${EXPENSE_CATEGORIES.join(', ')}`
  }),
  amount: Joi.number().integer().min(1).max(999999999).required().messages({
    'any.required': 'Jumlah budget harus diisi',
    'number.base': 'Jumlah budget harus berupa angka',
    'number.min': 'Jumlah budget minimum Rp 1',
    'number.max': 'Jumlah budget maksimum Rp 999.999.999'
  }),
  month: Joi.string().pattern(/^\d{4}-\d{2}$/).optional().messages({
    'string.pattern.base': 'Format month harus YYYY-MM'
  })
});

const periodSchema = Joi.string().valid('today', 'week', 'month').required().messages({
  'any.only': 'Periode harus today, week, atau month'
});

/**
 * Validates transaction payload.
 * @param {Object} input
 * @returns {{ error: string|null, value: Object }}
 */
export function validateTransactionInput(input) {
  const { error, value } = transactionSchema.validate(input, { abortEarly: true, stripUnknown: true });
  return {
    error: error ? error.details[0].message : null,
    value
  };
}

/**
 * Validates budget payload.
 * @param {Object} input
 * @returns {{ error: string|null, value: Object }}
 */
export function validateBudgetInput(input) {
  const { error, value } = budgetSchema.validate(input, { abortEarly: true, stripUnknown: true });
  return {
    error: error ? error.details[0].message : null,
    value
  };
}

/**
 * Validates summary / stats period query parameter.
 * @param {string} period
 * @returns {{ error: string|null, value: string }}
 */
export function validatePeriod(period) {
  const { error, value } = periodSchema.validate(period);
  return {
    error: error ? error.details[0].message : null,
    value
  };
}
