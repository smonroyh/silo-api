// import type { VercelRequest, VercelResponse } from '@vercel/node';
// import { createRequire } from 'module';
// const require = createRequire(import.meta.url);
// const { createClient: createSupabaseClient } = require('@supabase/supabase-js');

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // 1. Verificar Autenticación con Supabase
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Missing Authorization header' });
    }

    const token = authHeader.replace('Bearer ', '');
    const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error("Missing Supabase configuration in server - stt-token.ts:35", {
        hasUrl: !!supabaseUrl,
        hasKey: !!supabaseServiceKey
      });
      return res.status(500).json({
        error: "Server Configuration Error",
        details: "Supabase URL or Service Key missing in Vercel Environment Variables"
      });
    }

    const supabase = createSupabaseClient(supabaseUrl, supabaseServiceKey);
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) {
      console.error("Auth validation failed: - stt-token.ts:49", authError?.message || "No user found for this token");
      return res.status(401).json({
        error: 'Invalid or expired session',
        auth_error: authError?.message
      });
    }

    // 2. STT Token usando Deepgram Token-Based Authentication (/auth/grant)
    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) {
      console.error("No DEEPGRAM_API_KEY set in Vercel Environment Variables - stt-token.ts:59");
      return res.status(500).json({ error: "Server Configuration Error: Missing Deepgram API Key" });
    }

    // Crear un JSON Web Token (JWT) válido por 10 minutos (600 segundos)
    const tokenResp = await fetch("https://api.deepgram.com/v1/auth/grant", {
      method: "POST",
      headers: {
        "Authorization": `Token ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ttl_seconds: 600
      })
    });

    if (!tokenResp.ok) {
      const errorText = await tokenResp.text();
      console.error("Error creating Deepgram auth grant: - stt-token.ts:77", errorText);
      let details = errorText;
      try { details = JSON.parse(errorText); } catch (e) { }
      return res.status(500).json({ error: "Failed to create temp key", details });
    }

    const tokenData = await tokenResp.json();

    // Retorna el JWT al cliente. Se pasa bajo la propiedad 'token' para no romper la compatibilidad actual.
    // Deepgram WebSockets aceptarán este JWT usando el mismo formato `Token <JWT>`
    return res.status(200).json({ token: tokenData.access_token });

  } catch (error: any) {
    console.error("Unhandled error in /api/stttoken: - stt-token.ts:90", error.message);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
