import { env } from 'lua-cli';

/**
 * Thin wrapper around Safaricom's Daraja API.
 *
 * Kept separate from the tools so the agent layer stays declarative and the
 * payment logic can be unit-tested (or swapped for a mock) on its own.
 */

const BASE_URL = () =>
  env('MPESA_ENV') === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';

export function normalizeMsisdn(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('254')) return digits;
  if (digits.startsWith('0')) return `254${digits.slice(1)}`;
  if (digits.length === 9) return `254${digits}`;
  throw new Error(
    `Could not read "${raw}" as a Kenyan phone number. Expected a format like 0712345678.`
  );
}

/** Daraja timestamp format: YYYYMMDDHHmmss, in EAT. */
function timestamp(): string {
  const eat = new Date(Date.now() + 3 * 60 * 60 * 1000);
  return eat.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

/**
 * Daraja does not always return JSON.
 *
 * Gateway errors ("no healthy upstream"), maintenance pages and some throttling
 * responses come back as plain text, and calling res.json() on those throws an
 * opaque SyntaxError that looks like a bug in our code. Read the body once,
 * then decide.
 */
async function readBody(res: Response, context: string): Promise<Record<string, any>> {
  const text = await res.text();

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `${context}: Daraja returned a non-JSON response (HTTP ${res.status}). ` +
        `This is usually an outage or gateway error on Safaricom's side, not a problem with the request. ` +
        `Body: ${text.slice(0, 200)}`
    );
  }
}

async function accessToken(): Promise<string> {
  const key = env('MPESA_CONSUMER_KEY');
  const secret = env('MPESA_CONSUMER_SECRET');
  if (!key || !secret) {
    throw new Error('MPESA_CONSUMER_KEY and MPESA_CONSUMER_SECRET must be set.');
  }

  const basic = Buffer.from(`${key}:${secret}`).toString('base64');
  const res = await fetch(
    `${BASE_URL()}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${basic}` } }
  );

  const body = (await readBody(res, 'Daraja auth')) as { access_token?: string };

  if (!res.ok) {
    throw new Error(`Daraja auth failed (${res.status}): ${JSON.stringify(body)}`);
  }
  if (!body.access_token) throw new Error('Daraja auth returned no access token.');
  return body.access_token;
}

export interface StkPushResult {
  checkoutRequestId: string;
  merchantRequestId: string;
  customerMessage: string;
}

export async function stkPush(params: {
  phone: string;
  amount: number;
  accountReference: string;
  description: string;
}): Promise<StkPushResult> {
  const shortcode = env('MPESA_SHORTCODE');
  const passkey = env('MPESA_PASSKEY');
  const callbackUrl = env('MPESA_CALLBACK_URL');

  if (!shortcode || !passkey || !callbackUrl) {
    throw new Error('MPESA_SHORTCODE, MPESA_PASSKEY and MPESA_CALLBACK_URL must be set.');
  }

  const ts = timestamp();
  const password = Buffer.from(`${shortcode}${passkey}${ts}`).toString('base64');
  const msisdn = normalizeMsisdn(params.phone);

  const res = await fetch(`${BASE_URL()}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: ts,
      TransactionType: 'CustomerPayBillOnline',
      // Daraja rejects decimals on the sandbox paybill.
      Amount: Math.round(params.amount),
      PartyA: msisdn,
      PartyB: shortcode,
      PhoneNumber: msisdn,
      CallBackURL: callbackUrl,
      AccountReference: params.accountReference.slice(0, 12),
      TransactionDesc: params.description.slice(0, 13),
    }),
  });

  const body = await readBody(res, 'STK push');

  // Daraja returns 200 with an error body in some failure modes, so check both.
  if (!res.ok || body.ResponseCode !== '0') {
    throw new Error(
      `STK push rejected: ${body.errorMessage || body.ResponseDescription || JSON.stringify(body)}`
    );
  }

  return {
    checkoutRequestId: body.CheckoutRequestID,
    merchantRequestId: body.MerchantRequestID,
    customerMessage: body.CustomerMessage,
  };
}

export type PaymentState = 'paid' | 'pending' | 'cancelled' | 'failed' | 'unknown';

export async function queryStkStatus(
  checkoutRequestId: string
): Promise<{ state: PaymentState; detail: string }> {
  const shortcode = env('MPESA_SHORTCODE');
  const passkey = env('MPESA_PASSKEY');
  const ts = timestamp();
  const password = Buffer.from(`${shortcode}${passkey}${ts}`).toString('base64');

  const res = await fetch(`${BASE_URL()}/mpesa/stkpushquery/v1/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: ts,
      CheckoutRequestID: checkoutRequestId,
    }),
  });

  const body = await readBody(res, 'STK status query');

  // Daraja rate-limits the query endpoint (spike arrest, ~5/min). A throttled
  // query tells us nothing about the payment — the customer may well have paid.
  // Reporting that as "failed" is the dangerous direction to be wrong in, so it
  // gets its own state and the caller is told to back off and retry.
  if (body.fault || body.detail?.errorcode?.includes?.('ratelimit')) {
    return {
      state: 'unknown',
      detail: 'Daraja rate-limited the status check. The payment may still have succeeded.',
    };
  }

  // 500.001.1001 means the subscriber hasn't acted on the prompt yet — that is
  // "pending", not an error. Treating it as failure is the classic STK bug.
  if (body.errorCode === '500.001.1001') {
    return { state: 'pending', detail: 'Customer has not entered their PIN yet.' };
  }

  switch (body.ResultCode) {
    case '0':
      return { state: 'paid', detail: body.ResultDesc || 'Payment received.' };
    case '1032':
      return { state: 'cancelled', detail: 'Customer cancelled the prompt.' };
    case '1037':
      return { state: 'pending', detail: 'Prompt timed out with no response.' };
    case '1':
      return { state: 'failed', detail: 'Insufficient balance.' };
    default:
      // Surface whatever Daraja actually said. Flattening an unmapped code to
      // "unknown" makes this exact case impossible to debug from the outside.
      return {
        state: 'failed',
        detail:
          body.ResultDesc ||
          body.errorMessage ||
          `Unmapped Daraja response (ResultCode=${body.ResultCode ?? 'none'}, errorCode=${body.errorCode ?? 'none'}): ${JSON.stringify(body)}`,
      };
  }
}