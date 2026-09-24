const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const express = require('express');
const Razorpay = require('razorpay');
const config = require('./config');
const { createDatabase, buildPaymentRepository } = require('./db');

const database = createDatabase(config.databasePath);
const payments = buildPaymentRepository(database);
const razorpay = new Razorpay({
  key_id: config.razorpayKeyId,
  key_secret: config.razorpayKeySecret
});

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));

function sendJsonError(res, statusCode, code, message) {
  return res.status(statusCode).json({
    success: false,
    error: {
      code,
      message
    }
  });
}

function isProbablyRazorpayId(value, prefix) {
  return typeof value === 'string' && value.startsWith(`${prefix}_`) && value.length > prefix.length + 2;
}

function timingSafeEqualHex(expected, actual) {
  if (typeof actual !== 'string' || actual.length === 0) {
    return false;
  }

  const expectedBuffer = Buffer.from(expected, 'hex');
  const actualBuffer = Buffer.from(actual, 'hex');

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function createAccessToken(internalPaymentId, accessExpiresAt) {
  const payload = `${internalPaymentId}:${accessExpiresAt}`;
  const payloadBase64 = Buffer.from(payload, 'utf8').toString('base64url');
  const signature = crypto
    .createHmac('sha256', config.resumeAccessSecret)
    .update(payloadBase64)
    .digest('base64url');

  return `${payloadBase64}.${signature}`;
}

function verifyAccessToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) {
    return null;
  }

  const [payloadBase64, signature] = token.split('.', 2);
  const expectedSignature = crypto
    .createHmac('sha256', config.resumeAccessSecret)
    .update(payloadBase64)
    .digest('base64url');

  if (signature !== expectedSignature) {
    return null;
  }

  let payload;
  try {
    payload = Buffer.from(payloadBase64, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const separatorIndex = payload.indexOf(':');
  if (separatorIndex === -1) {
    return null;
  }

  const internalPaymentId = payload.slice(0, separatorIndex);
  const accessExpiresAt = payload.slice(separatorIndex + 1);
  const expiresAtMs = Date.parse(accessExpiresAt);

  if (!internalPaymentId || Number.isNaN(expiresAtMs) || expiresAtMs <= Date.now()) {
    return null;
  }

  return {
    internalPaymentId,
    accessExpiresAt
  };
}

function parseBearerToken(headerValue) {
  if (typeof headerValue !== 'string') {
    return null;
  }

  const [scheme, token] = headerValue.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return null;
  }

  return token.trim();
}

function getResumeAuthorization(req) {
  return parseBearerToken(req.headers.authorization) || (typeof req.query.token === 'string' ? req.query.token : null);
}

function buildAccessResponse(payment) {
  const accessToken = createAccessToken(payment.internal_payment_id, payment.access_expires_at);
  return {
    accessToken,
    accessExpiresAt: payment.access_expires_at,
    payment: {
      internalPaymentId: payment.internal_payment_id,
      razorpayOrderId: payment.razorpay_order_id,
      razorpayPaymentId: payment.razorpay_payment_id,
      amountPaise: payment.amount_paise,
      currency: payment.currency,
      status: payment.status,
      verifiedAt: payment.verified_at
    }
  };
}

function verifyAndGrantAccess(razorpayOrderId, razorpayPaymentId, razorpaySignature) {
  if (!isProbablyRazorpayId(razorpayOrderId, 'order')) {
    return { statusCode: 400, code: 'invalid_order_id', message: 'A valid Razorpay order ID is required.' };
  }
  if (!isProbablyRazorpayId(razorpayPaymentId, 'pay')) {
    return { statusCode: 400, code: 'invalid_payment_id', message: 'A valid Razorpay payment ID is required.' };
  }
  if (typeof razorpaySignature !== 'string' || razorpaySignature.length < 20) {
    return { statusCode: 400, code: 'invalid_signature', message: 'A valid Razorpay signature is required.' };
  }

  const payment = payments.getByOrderId(razorpayOrderId);
  if (!payment) {
    return { statusCode: 404, code: 'payment_not_found', message: 'Payment order was not found.' };
  }
  if (payment.amount_paise !== config.amountPaise || payment.currency !== config.currency) {
    return { statusCode: 409, code: 'amount_mismatch', message: 'Payment amount or currency does not match the expected plan.' };
  }
  if (payment.razorpay_payment_id && payment.razorpay_payment_id !== razorpayPaymentId) {
    return { statusCode: 409, code: 'duplicate_payment_mismatch', message: 'This order is already linked to a different payment.' };
  }

  const expectedSignature = crypto
    .createHmac('sha256', config.razorpayKeySecret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');
  if (!timingSafeEqualHex(expectedSignature, razorpaySignature)) {
    return { statusCode: 400, code: 'invalid_signature', message: 'Razorpay signature verification failed.' };
  }

  if (payment.status === 'verified') {
    return { payment, alreadyVerified: true };
  }

  const verifiedAt = new Date().toISOString();
  const accessExpiresAt = new Date(Date.now() + config.accessTtlHours * 60 * 60 * 1000).toISOString();
  return {
    payment: payments.markVerified({
      razorpayOrderId,
      razorpayPaymentId,
      verifiedAt,
      accessExpiresAt,
      updatedAt: verifiedAt
    }),
    alreadyVerified: false
  };
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && config.frontendOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  return next();
});

app.get('/health', (req, res) => {
  res.json({ success: true, status: 'ok' });
});

app.post('/api/payments/create-order', async (req, res) => {
  const now = new Date().toISOString();
  const internalPaymentId = crypto.randomUUID();
  const pendingOrderId = `pending_${internalPaymentId}`;

  try {
    payments.createPendingPayment({
      internalPaymentId,
      razorpayOrderId: pendingOrderId,
      amountPaise: config.amountPaise,
      currency: config.currency,
      status: 'creating_order',
      createdAt: now,
      updatedAt: now
    });
  } catch (error) {
    return sendJsonError(res, 500, 'database_error', 'Unable to initialize the payment record.');
  }

  try {
    const razorpayOrder = await razorpay.orders.create({
      amount: config.amountPaise,
      currency: config.currency,
      receipt: internalPaymentId,
      notes: {
        purpose: 'resume_access',
        internal_payment_id: internalPaymentId
      }
    });

    payments.markOrderCreated({
      razorpayOrderId: pendingOrderId,
      status: 'created',
      updatedAt: new Date().toISOString(),
      lastError: null
    });

    database.prepare(`
      UPDATE resume_payments
      SET razorpay_order_id = ?, updated_at = ?
      WHERE internal_payment_id = ?
    `).run(razorpayOrder.id, new Date().toISOString(), internalPaymentId);

    return res.json({
      success: true,
      order: {
        id: razorpayOrder.id,
        amount: razorpayOrder.amount,
        currency: razorpayOrder.currency,
        receipt: razorpayOrder.receipt
      },
      keyId: config.razorpayKeyId,
      amountPaise: config.amountPaise,
      currency: config.currency,
      displayAmount: '₹10',
      businessName: config.appName,
      description: 'Resume access payment'
    });
  } catch (error) {
    payments.markFailed({
      razorpayOrderId: pendingOrderId,
      status: 'order_creation_failed',
      updatedAt: new Date().toISOString(),
      lastError: error.message
    });

    return sendJsonError(res, 502, 'payment_provider_error', 'Failed to create the Razorpay order.');
  }
});

app.post('/api/payments/verify', (req, res) => {
  const result = verifyAndGrantAccess(
    req.body?.razorpay_order_id,
    req.body?.razorpay_payment_id,
    req.body?.razorpay_signature
  );
  if (result.statusCode) {
    return sendJsonError(res, result.statusCode, result.code, result.message);
  }

  return res.json({
    success: true,
    alreadyVerified: result.alreadyVerified,
    ...buildAccessResponse(result.payment)
  });
});

app.post('/api/payments/callback', (req, res) => {
  const result = verifyAndGrantAccess(
    req.body?.razorpay_order_id,
    req.body?.razorpay_payment_id,
    req.body?.razorpay_signature
  );
  if (result.statusCode) {
    return sendJsonError(res, result.statusCode, result.code, result.message);
  }

  let returnUrl;
  try {
    returnUrl = new URL(config.frontendReturnUrl);
  } catch {
    return sendJsonError(res, 500, 'invalid_return_url', 'The configured payment return URL is invalid.');
  }
  if (!config.frontendOrigins.includes(returnUrl.origin) || returnUrl.search || returnUrl.hash) {
    return sendJsonError(res, 500, 'invalid_return_url', 'The configured payment return URL is not allowed.');
  }

  const frontendPath = `${returnUrl.origin}${returnUrl.pathname.replace(/\/$/, '')}`;
  const access = buildAccessResponse(result.payment);
  return res.redirect(303, `${frontendPath}/#resume_token=${encodeURIComponent(access.accessToken)}`);
});

app.get('/api/resume/access-status', (req, res) => {
  const token = getResumeAuthorization(req);
  if (!token) {
    return res.json({ success: true, accessGranted: false });
  }

  const tokenPayload = verifyAccessToken(token);
  if (!tokenPayload) {
    return res.json({ success: true, accessGranted: false });
  }

  const payment = payments.getByInternalPaymentId(tokenPayload.internalPaymentId);
  if (!payment || payment.status !== 'verified' || payment.access_expires_at !== tokenPayload.accessExpiresAt) {
    return res.json({ success: true, accessGranted: false });
  }

  return res.json({
    success: true,
    accessGranted: true,
    accessExpiresAt: payment.access_expires_at
  });
});

app.get('/api/resume/access', (req, res) => {
  const token = getResumeAuthorization(req);
  if (!token) {
    return sendJsonError(res, 401, 'access_token_missing', 'A valid access token is required.');
  }

  const tokenPayload = verifyAccessToken(token);
  if (!tokenPayload) {
    return sendJsonError(res, 403, 'access_token_invalid', 'The resume access token is invalid or expired.');
  }

  const payment = payments.getByInternalPaymentId(tokenPayload.internalPaymentId);
  if (!payment || payment.status !== 'verified') {
    return sendJsonError(res, 403, 'access_denied', 'Resume access is not authorized.');
  }

  if (payment.amount_paise !== config.amountPaise || payment.currency !== config.currency) {
    return sendJsonError(res, 409, 'amount_mismatch', 'Stored payment data is invalid.');
  }

  if (payment.access_expires_at !== tokenPayload.accessExpiresAt) {
    return sendJsonError(res, 403, 'access_token_expired', 'The resume access token has expired.');
  }

  if (!fs.existsSync(config.resumeFilePath)) {
    return sendJsonError(res, 404, 'resume_not_found', 'Resume file was not found on the server.');
  }

  const disposition = typeof req.query.disposition === 'string' && req.query.disposition === 'inline' ? 'inline' : 'attachment';
  const fileName = path.basename(config.resumeFilePath);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${disposition}; filename="${fileName}"`);

  const readStream = fs.createReadStream(config.resumeFilePath);
  readStream.on('error', () => {
    if (!res.headersSent) {
      sendJsonError(res, 500, 'resume_stream_error', 'Unable to stream the resume file.');
    } else {
      res.destroy();
    }
  });

  return readStream.pipe(res);
});

app.use((req, res) => {
  return sendJsonError(res, 404, 'not_found', 'The requested resource was not found.');
});

app.listen(config.port, () => {
  console.log(`Payment backend listening on port ${config.port}`);
});
