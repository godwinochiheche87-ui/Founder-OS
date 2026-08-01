// netlify/functions/check-payment-status.js
//
// Polled by pay-pending.html every few seconds while waiting for a bank
// transfer to confirm. Just checks whether flutterwave-webhook.js (or
// verify-payment.js) has recorded this tx_ref in Supabase yet.
//
// Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "Server misconfigured" }) };
  }

  const tx_ref = event.queryStringParameters && event.queryStringParameters.tx_ref;
  if (!tx_ref) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing tx_ref" }) };
  }

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/paid_customers?tx_ref=eq.${encodeURIComponent(tx_ref)}&select=email,account_created`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );
    if (!res.ok) {
      return { statusCode: 500, body: JSON.stringify({ error: "Lookup failed" }) };
    }
    const rows = await res.json();
    const record = Array.isArray(rows) ? rows[0] : null;

    return {
      statusCode: 200,
      body: JSON.stringify({ paid: !!record, email: record ? record.email : null }),
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: "Server error" }) };
  }
};
