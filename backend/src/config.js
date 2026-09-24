const path = require('path');

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`${name} is required`);
  }

  return value.trim();
}

function parseOrigins(value) {
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

const config = {
  port: Number(process.env.PORT || 3000),
  razorpayKeyId: requiredEnv('RAZORPAY_KEY_ID'),
  razorpayKeySecret: requiredEnv('RAZORPAY_KEY_SECRET'),
  resumeAccessSecret: requiredEnv('RESUME_ACCESS_SECRET'),
  frontendOrigins: parseOrigins(process.env.FRONTEND_ORIGINS || 'http://localhost:5500,http://127.0.0.1:5500'),
  frontendReturnUrl: process.env.FRONTEND_RETURN_URL || parseOrigins(process.env.FRONTEND_ORIGINS || 'http://localhost:5500,http://127.0.0.1:5500')[0],
  appName: process.env.APP_NAME || 'Dayananda K S',
  databasePath: process.env.PAYMENTS_DB_PATH || path.resolve(__dirname, '..', 'data', 'payments.sqlite'),
  resumeFilePath: process.env.RESUME_FILE_PATH || path.resolve(__dirname, '..', '..', 'resume.pdf'),
  accessTtlHours: Number(process.env.RESUME_ACCESS_TTL_HOURS || 24),
  amountPaise: 1000,
  currency: 'INR',
  cookieSecure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : process.env.NODE_ENV === 'production'
};

if (!Number.isFinite(config.port) || config.port <= 0) {
  throw new Error('PORT must be a positive number');
}

if (!Number.isFinite(config.accessTtlHours) || config.accessTtlHours <= 0) {
  throw new Error('RESUME_ACCESS_TTL_HOURS must be a positive number');
}

module.exports = config;
