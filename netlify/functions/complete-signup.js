// netlify/functions/complete-signup.js
//
// This is the actual gate: an account is only created if paid_customers has a
// matching, not-yet-used row for this email + tx_ref. This runs no matter how
// someone arrives at this endpoint, so guessing/faking the login.html URL
// params alone can't create an account without a real, verified payment.
//
// Requires:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY   (mark "Contains secret values")

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "Signup is not configured yet." }) };
  }

  try {
    const { email, password, tx_ref } = JSON.parse(event.body || "{}");
    if (!email || !password || !tx_ref) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing required fields." }) };
    }
    if (password.length < 6) {
      return { statusCode: 400, body: JSON.stringify({ error: "Password must be at least 6 characters." }) };
    }

    const adminHeaders = {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    };

    // 1. Confirm this is a real, unused, paid transaction for this exact email
    const lookupRes = await fetch(
      `${SUPABASE_URL}/rest/v1/paid_customers?tx_ref=eq.${encodeURIComponent(tx_ref)}&email=eq.${encodeURIComponent(
        email.toLowerCase()
      )}&select=*`,
      { headers: adminHeaders }
    );
    const rows = await lookupRes.json();
    const record = Array.isArray(rows) ? rows[0] : null;

    if (!record) {
      return { statusCode: 403, body: JSON.stringify({ error: "No matching payment found for this email." }) };
    }
    if (record.account_created) {
      return {
        statusCode: 409,
        body: JSON.stringify({ error: "An account already exists for this payment. Please sign in instead." }),
      };
    }

    // 2. Create the Supabase auth user (admin API -- service role only, never client-side)
    const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    const createData = await createRes.json();

    if (!createRes.ok) {
      const msg = (createData && (createData.msg || createData.error_description)) || "Could not create account.";
      return { statusCode: 400, body: JSON.stringify({ error: msg }) };
    }

    // 3. Mark this payment as used so it can't be used to create a second account
    await fetch(`${SUPABASE_URL}/rest/v1/paid_customers?tx_ref=eq.${encodeURIComponent(tx_ref)}`, {
      method: "PATCH",
      headers: { ...adminHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ account_created: true }),
    });

    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: "Something went wrong. Please try again." }) };
  }
};
