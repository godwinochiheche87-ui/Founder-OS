// netlify/functions/flutterwave-webhook.js
//
// Flutterwave calls this URL directly (server-to-server) whenever a transaction's
// status changes -- including bank transfers that only confirm a few minutes
// after the buyer clicks "I have sent the money." This is what makes those
// payments work even if the buyer closes their browser tab while waiting.
//
// Set up in Flutterwave dashboard: Settings -> Webhooks
//   URL:         https://YOURSITE.netlify.app/.netlify/functions/flutterwave-webhook
//   Secret Hash: any random string you choose -- put the SAME string in both
//                Flutterwave's dashboard and the FLW_WEBHOOK_SECRET_HASH env var below.
//
// Requires these environment variables in Netlify:
//   FLW_WEBHOOK_SECRET_HASH      the secret hash you set in Flutterwave's dashboard (mark "Contains secret values")
//   FLW_SECRET_KEY               Flutterwave Secret Key
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const FLW_WEBHOOK_SECRET_HASH = process.env.FLW_WEBHOOK_SECRET_HASH;
  const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!FLW_WEBHOOK_SECRET_HASH || !FLW_SECRET_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("flutterwave-webhook: missing required env vars");
    return { statusCode: 500, body: "Server misconfigured" };
  }

  // Flutterwave sends this header on every webhook call so we can confirm the
  // request genuinely came from them and not someone hitting this URL directly.
  const signature = event.headers["verif-hash"] || event.headers["Verif-Hash"];
  if (!signature || signature !== FLW_WEBHOOK_SECRET_HASH) {
    return { statusCode: 401, body: "Invalid signature" };
  }

  try {
    const payload = JSON.parse(event.body || "{}");
    const txId = payload.data && payload.data.id;
    if (!txId) {
      return { statusCode: 200, body: "Ignored: no transaction id in payload" };
    }

    // Never trust the webhook payload's own "status" field -- always re-verify
    // directly against Flutterwave's API using the secret key.
    const verifyRes = await fetch(
      `https://api.flutterwave.com/v3/transactions/${encodeURIComponent(txId)}/verify`,
      { headers: { Authorization: `Bearer ${FLW_SECRET_KEY}` } }
    );
    const verifyData = await verifyRes.json();
    const tx = verifyData.data;

    if (verifyData.status !== "success" || !tx || tx.status !== "successful") {
      return { statusCode: 200, body: "Ignored: transaction not successful" };
    }

    const email = tx.customer && tx.customer.email;
    if (!email) {
      return { statusCode: 200, body: "Ignored: no customer email" };
    }

    const recorded = await recordPaidCustomer(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, tx, email);
    if (!recorded) {
      return { statusCode: 500, body: "Database write failed" };
    }

    return { statusCode: 200, body: "OK" };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: "Server error" };
  }
};

// Same function as in verify-payment.js -- see the comment there for why
// ignore-duplicates (not merge-duplicates) matters here.
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
