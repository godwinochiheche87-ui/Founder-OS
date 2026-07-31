// netlify/functions/initiate-payment.js
//
// Starts a Flutterwave payment. The client only ever sends an email + a
// currency choice ("NGN" or "USD") -- the actual price comes from PRICES
// below, on the server, so nobody can tamper with the amount from the browser.
//
// Requires this environment variable set in Netlify (mark it "Contains secret values"):
//   FLW_SECRET_KEY   your Flutterwave Secret Key (Settings -> API in the Flutterwave dashboard)
//
// Optional overrides (plain env vars, no need to mark secret):
//   PRICE_NGN   default 39980
//   PRICE_USD   default 33

const PRICES = {
  NGN: Number(process.env.PRICE_NGN || 39980),
  USD: Number(process.env.PRICE_USD || 33),
};

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;
  if (!FLW_SECRET_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "Payments are not configured yet." }) };
  }

  try {
    const { email, currency } = JSON.parse(event.body || "{}");
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { statusCode: 400, body: JSON.stringify({ error: "Please enter a valid email address." }) };
    }

    const cur = currency === "USD" ? "USD" : "NGN";
    const amount = PRICES[cur];
    const tx_ref = `founderos-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    const siteUrl = `https://${event.headers.host}`;

    const flwRes = await fetch("https://api.flutterwave.com/v3/payments", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${FLW_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        tx_ref,
        amount,
        currency: cur,
        redirect_url: `${siteUrl}/.netlify/functions/verify-payment`,
        customer: { email },
        customizations: {
          title: "Founder's Self-Serve Notion OS",
          description: "Lifetime access",
        },
      }),
    });

    const data = await flwRes.json();

    if (data.status !== "success" || !data.data || !data.data.link) {
      console.error("Flutterwave initiate failed", data);
      return { statusCode: 502, body: JSON.stringify({ error: "Could not start payment. Please try again." }) };
    }

    return { statusCode: 200, body: JSON.stringify({ link: data.data.link }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: "Something went wrong. Please try again." }) };
  }
};
