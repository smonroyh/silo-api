// import type { VercelRequest, VercelResponse } from '@vercel/node';
import OpenAI from 'openai';
// import { createRequire } from 'module';
// const require = createRequire(import.meta.url);
// const { createClient } = require('@supabase/supabase-js');

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';




export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // 1. Verificar Autenticación con Supabase
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Missing Authorization header' });
    }

    const token = authHeader.replace('Bearer ', '');
    const supabaseUrl = process.env.VITE_SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error("Missing Supabase configuration in server - translate.ts:39");
      return res.status(500).json({ error: "Server Configuration Error" });
    }

    const supabase = createSupabaseClient(supabaseUrl, supabaseServiceKey);
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    // 2. Ejecutar lógica de traducción
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error("No OPENAI_API_KEY set - translate.ts:53");
      return res.status(500).json({ error: "Server Configuration Error" });
    }

    const { text, prompt_user, prompt_system } = req.body;

    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid text field' });
    }

    // Configurar el cliente de OpenAI de manera segura solo del lado del backend Vercel
    const openai = new OpenAI({ apiKey });



    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: prompt_system },
        { role: "user", content: prompt_user }
      ],
      temperature: 0.3,
      max_tokens: 150
    });

    const translated = completion.choices[0]?.message?.content?.trim() || '[Error de traducción]';
    return res.status(200).json({ translated });

  } catch (error: any) {
    console.error("Error calling OpenAI: - translate.ts:82", error.message);
    return res.status(500).json({ error: "Failed to translate text" });
  }
}
