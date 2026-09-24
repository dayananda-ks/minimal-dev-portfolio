const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

function createDatabase(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });

  const database = new Database(databasePath);
  database.pragma('journal_mode = WAL');
  database.exec(`
    CREATE TABLE IF NOT EXISTS resume_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      internal_payment_id TEXT NOT NULL UNIQUE,
      razorpay_order_id TEXT NOT NULL UNIQUE,
      razorpay_payment_id TEXT UNIQUE,
      amount_paise INTEGER NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL,
      verified_at TEXT,
      access_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_resume_payments_status ON resume_payments(status);
    CREATE INDEX IF NOT EXISTS idx_resume_payments_verified_at ON resume_payments(verified_at);
  `);

  return database;
}

function buildPaymentRepository(database) {
  return {
    createPendingPayment(payment) {
      const statement = database.prepare(`
        INSERT INTO resume_payments (
          internal_payment_id,
          razorpay_order_id,
          amount_paise,
          currency,
          status,
          created_at,
          updated_at
        ) VALUES (
          @internalPaymentId,
          @razorpayOrderId,
          @amountPaise,
          @currency,
          @status,
          @createdAt,
          @updatedAt
        )
      `);

      statement.run({
        internalPaymentId: payment.internalPaymentId,
        razorpayOrderId: payment.razorpayOrderId,
        amountPaise: payment.amountPaise,
        currency: payment.currency,
        status: payment.status,
        createdAt: payment.createdAt,
        updatedAt: payment.updatedAt
      });

      return this.getByOrderId(payment.razorpayOrderId);
    },

    getByOrderId(orderId) {
      return database.prepare('SELECT * FROM resume_payments WHERE razorpay_order_id = ?').get(orderId) || null;
    },

    getByInternalPaymentId(internalPaymentId) {
      return database.prepare('SELECT * FROM resume_payments WHERE internal_payment_id = ?').get(internalPaymentId) || null;
    },

    markOrderCreated({ razorpayOrderId, status, updatedAt, lastError }) {
      database.prepare(`
        UPDATE resume_payments
        SET status = ?, updated_at = ?, last_error = ?
        WHERE razorpay_order_id = ?
      `).run(status, updatedAt, lastError || null, razorpayOrderId);
      return this.getByOrderId(razorpayOrderId);
    },

    markVerified({ razorpayOrderId, razorpayPaymentId, verifiedAt, accessExpiresAt, updatedAt }) {
      database.prepare(`
        UPDATE resume_payments
        SET razorpay_payment_id = ?, status = ?, verified_at = ?, access_expires_at = ?, updated_at = ?, last_error = NULL
        WHERE razorpay_order_id = ?
      `).run(razorpayPaymentId, 'verified', verifiedAt, accessExpiresAt, updatedAt, razorpayOrderId);
      return this.getByOrderId(razorpayOrderId);
    },

    markFailed({ razorpayOrderId, status, updatedAt, lastError }) {
      database.prepare(`
        UPDATE resume_payments
        SET status = ?, updated_at = ?, last_error = ?
        WHERE razorpay_order_id = ?
      `).run(status, updatedAt, lastError || null, razorpayOrderId);
      return this.getByOrderId(razorpayOrderId);
    }
  };
}

module.exports = {
  createDatabase,
  buildPaymentRepository
};
