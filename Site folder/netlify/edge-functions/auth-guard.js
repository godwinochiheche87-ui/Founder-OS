// netlify/edge-functions/auth-guard.js
//
// Runs at the edge, before app.html (or any protected page) is ever served.
// No valid session cookie -> the browser never receives the file's source at all.
//
// Requires these environment variables set in Netlify (Site configuration ->
// Environment variables), available to Edge Functions automatically:
//   SUPABASE_URL        e.g. https://xxxxx.supabase.co
//   SUPABASE_ANON_KEY   your Supabase project's anon/public key

export default async (request, context) => {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    // Misconfigured -> fail closed rather than accidentally serving protected content
    console.error("auth-guard: missing SUPABASE_URL or SUPABASE_ANON_KEY env vars");
    return redirectToLogin(request);
  }

  const cookies = parseCookies(request.headers.get("cookie") || "");
  let accessToken = cookies["sb-access-token"];
  const refreshToken = cookies["sb-refresh-token"];

  const setCookies = [];

  let valid = accessToken
    ? await verifyAccessToken(SUPABASE_URL, SUPABASE_ANON_KEY, accessToken)
    : false;

  // Access token missing/expired -> try the refresh token so a returning user
  // (browser closed for a while, access token past its ~1hr life) doesn't get
  // bounced to /login even though they're still legitimately signed in.
  if (!valid && refreshToken) {
    const refreshed = await refreshSession(SUPABASE_URL, SUPABASE_ANON_KEY, refreshToken);
    if (refreshed) {
      valid = true;
      accessToken = refreshed.access_token;
      setCookies.push(cookieString(request, "sb-access-token", refreshed.access_token));
      setCookies.push(cookieString(request, "sb-refresh-token", refreshed.refresh_token));
    }
  }

  if (!valid) {
    return redirectToLogin(request);
  }

  const response = await context.next();
  for (const c of setCookies) {
    response.headers.append("Set-Cookie", c);
  }
  return response;
};

export const config = {
  // Add more paths/patterns here as you add more protected pages, e.g. "/app/*"
  path: ["/app.html"],
};

async function verifyAccessToken(supabaseUrl, anonKey, token) {
  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${token}`,
      },
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function refreshSession(supabaseUrl, anonKey, refreshToken) {
  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: {
        apikey: anonKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.access_token || !data.refresh_token) return null;
    return data;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  });
  return out;
}

function cookieString(request, name, value) {
  const isHttps = new URL(request.url).protocol === "https:";
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "Max-Age=2592000", // 30 days; the token's own expiry is what actually gets checked
    "SameSite=Lax",
  ];
  if (isHttps) parts.push("Secure");
  return parts.join("; ");
}

function redirectToLogin(request) {
  const url = new URL(request.url);
  const redirectTo = encodeURIComponent(url.pathname + url.search);
  return Response.redirect(`${url.origin}/login.html?redirect=${redirectTo}`, 302);
}
