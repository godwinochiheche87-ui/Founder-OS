// netlify/functions/verify-payment.js
//
// Flutterwave redirects the buyer's browser here after checkout. We do NOT
// trust the redirect params alone (they're easy to fake) -- we re-verify the
// transaction directly against Flutterwave's API using the secret key, then
// record it in Supabase so complete-signup.js can confirm it was really paid.
//
// Requires these environment variables in Netlify:
//   FLW_SECRET_KEY               Flutterwave Secret Key (mark "Contains secret values")
//   SUPABASE_URL                 same value used elsewhere in this project
//   SUPABASE_SERVICE_ROLE_KEY    Supabase service_role key (Project Settings -> API)
//                                 (mark "Contains secret values" -- this key bypasses
//                                  all Row Level Security, never expose it to the browser)

exports.handler = async (event) => {
  const siteUrl = `https://${event.headers.host}`;
  const params = event.queryStringParameters || {};
  const { status, tx_ref, transaction_id } = params;

  const failRedirect = (reason) => ({
    statusCode: 302,
    headers: { Location: `${siteUrl}/pay.html?error=${encodeURIComponent(reason)}` },
  });

  const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!FLW_SECRET_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("verify-payment: missing required env vars");
    return failRedirect("server_misconfigured");
  }

  if (status !== "successful" || !transaction_id) {
    return failRedirect("payment_not_completed");
  }

  try {
    // Re-verify against Flutterwave directly -- never trust redirect query params alone
    const verifyRes = await fetch(
      `https://api.flutterwave.com/v3/transactions/${encodeURIComponent(transaction_id)}/verify`,
      { headers: { Authorization: `Bearer ${FLW_SECRET_KEY}` } }
    );
    const verifyData = await verifyRes.json();
    const tx = verifyData.data;

    if (verifyData.status !== "success" || !tx || tx.status !== "successful" || tx.tx_ref !== tx_ref) {
      console.error("verify-payment: verification mismatch", verifyData);
      return failRedirect("verification_failed");
    }

    const email = tx.customer && tx.customer.email;
    if (!email) return failRedirect("missing_email");

    // Record the paid transaction so complete-signup.js can check against it.
    // on_conflict=tx_ref makes this safe to call more than once for the same transaction.
    const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/paid_customers?on_conflict=tx_ref`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify([
        {
          email: email.toLowerCase(),
          tx_ref: tx.tx_ref,
          amount: tx.amount,
          currency: tx.currency,
          account_created: false,
        },
      ]),
    });

    if (!upsertRes.ok) {
      console.error("verify-payment: Supabase upsert failed", await upsertRes.text());
      return failRedirect("recording_failed");
    }

    return {
      statusCode: 302,
      headers: {
        Location: `${siteUrl}/login.html?mode=signup&email=${encodeURIComponent(email)}&tx=${encodeURIComponent(tx.tx_ref)}`,
      },
    };
  } catch (err) {
    console.error(err);
    return failRedirect("server_error");
  }
};
