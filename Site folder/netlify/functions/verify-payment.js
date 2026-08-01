// netlify/functions/verify-payment.js
//
// Flutterwave redirects the buyer's browser here after checkout. We do NOT
// trust the redirect params alone (they're easy to fake) -- we re-verify the
// transaction directly against Flutterwave's API using the secret key.
//
// Card payments usually come back "successful" immediately. Bank transfers
// (very common in Nigeria) come back "pending" here -- the money hasn't been
// confirmed yet -- so those get sent to pay-pending.html, which polls until
// the flutterwave-webhook.js function confirms it in the background.
//
// Requires these environment variables in Netlify:
//   FLW_SECRET_KEY               Flutterwave Secret Key (mark "Contains secret values")
//   SUPABASE_URL                 same value used elsewhere in this project
//   SUPABASE_SERVICE_ROLE_KEY    Supabase service_role key (mark "Contains secret values")

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

  if (status === "cancelled" || !transaction_id) {
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

    if (verifyData.status !== "success" || !tx || tx.tx_ref !== tx_ref) {
      console.error("verify-payment: verification mismatch", verifyData);
      return failRedirect("verification_failed");
    }

    const email = tx.customer && tx.customer.email;

    if (tx.status === "successful") {
      if (!email) return failRedirect("missing_email");
      const recorded = await recordPaidCustomer(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, tx, email);
      if (!recorded) return failRedirect("recording_failed");
      return {
        statusCode: 302,
        headers: {
          Location: `${siteUrl}/login.html?mode=signup&email=${encodeURIComponent(email)}&tx=${encodeURIComponent(tx.tx_ref)}`,
        },
      };
    }

    if (tx.status === "pending") {
      // Bank transfer / other async method -- money not confirmed yet.
      // Send them to a waiting page; flutterwave-webhook.js will confirm this
      // in the background once Flutterwave actually receives the funds.
      return {
        statusCode: 302,
        headers: {
          Location: `${siteUrl}/pay-pending.html?tx=${encodeURIComponent(tx.tx_ref)}&email=${encodeURIComponent(email || "")}`,
        },
      };
    }

    // failed / abandoned / anything else
    return failRedirect("verification_failed");
  } catch (err) {
    console.error(err);
    return failRedirect("server_error");
  }
};

// Shared logic (also used by flutterwave-webhook.js, copied there since each
// Netlify function bundles independently). Uses ignore-duplicates (not
// merge-duplicates) on purpose: if this transaction's row already exists --
// e.g. the webhook already recorded it, or an account was already created
// from it -- this must NOT overwrite it back to account_created=false.
async function recordPaidCustomer(supabaseUrl, serviceKey, tx, email) {
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/paid_customers?on_conflict=tx_ref`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        Prefer: "resolution=ignore-duplicates,return=minimal",
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
    if (!res.ok) {
      console.error("recordPaidCustomer failed", await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error(err);
    return false;
  }
}
