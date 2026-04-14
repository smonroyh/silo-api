// import type { VercelRequest, VercelResponse } from '@vercel/node';
import OpenAI from 'openai';
// import { createRequire } from 'module';
// const require = createRequire(import.meta.url);
// const { createClient } = require('@supabase/supabase-js');

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';


export interface GlossaryEntry {
  id: string;
  english: string;
  spanishVariants: string[];
}

const filterRelevantGlossary = (text: string, fullGlossary: GlossaryEntry[], isSourceEs: boolean): GlossaryEntry[] => {
  if (!fullGlossary || fullGlossary.length === 0) return [];

  const normalizedText = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // Función auxiliar para extraer partes significativas de un término (ej: "AC unit (Air-con)" -> ["AC unit", "Air-con"])
  const getSubTerms = (term: string) => {
    const parts = [term];
    const match = term.match(/^(.*?)\s*\((.*?)\)\s*$/);
    if (match) {
      if (match[1]) parts.push(match[1].trim());
      if (match[2]) parts.push(match[2].trim());
    }
    return parts.map(p => p.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""));
  };

  return fullGlossary.filter(entry => {
    if (!entry || !entry.english || !Array.isArray(entry.spanishVariants)) return false;

    if (isSourceEs) {
      return entry.spanishVariants.some(variant => {
        const subTerms = getSubTerms(variant);
        return subTerms.some(st => normalizedText.includes(st));
      });
    } else {
      const subTerms = getSubTerms(entry.english);
      return subTerms.some(st => normalizedText.includes(st));
    }
  });
};

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
      console.error("Missing Supabase configuration in server - translate.ts:74");
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
      console.error("No OPENAI_API_KEY set - translate.ts:88");
      return res.status(500).json({ error: "Server Configuration Error" });
    }

    const { text, source_lang, sourceLangName, target_lang, context_str, glossary } = req.body;

    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid text field' });
    }

    // Configurar el cliente de OpenAI de manera segura solo del lado del backend Vercel
    const openai = new OpenAI({ apiKey });

    // Armar glosario
    let glossary_str = "";
    if (glossary && glossary.length > 0) {
      const isSourceEs = source_lang.includes('es');
      const isSourceEn = source_lang.includes('en');
      const relevantTerms = filterRelevantGlossary(text, glossary, isSourceEs);

      let items = '';

      if (isSourceEs) {
        items = relevantTerms.map(g => {
          const spanishList = g.spanishVariants.map(v => `'${v}'`).join(' or ');
          return spanishList ? `- If the original text contains ${spanishList}, you must translate it to: '${g.english}'` : '';
        }).filter(Boolean).join('\n');
      } else if (isSourceEn) {
        items = relevantTerms.map(g => {
          const spanishList = g.spanishVariants.join(' / ');
          return spanishList ? `- If the original text contains '${g.english}', you must output ALL variants exactly as: '${spanishList}'` : '';
        }).filter(Boolean).join('\n');
      }

      if (items) {
        glossary_str = `\nTERMINOLOGY CONSTRAINTS (MANDATORY):\nFollow these exact translation rules, NO EXCEPTIONS:\n${items}\n`;
      }
    }

    const prompt_system = `You are a professional real-time interpreter.
Translate strictly from ${sourceLangName} to ${target_lang}.
Rules:
1. Provide ONLY the translation. No explanations.
2. If terminology constraints are provided, you MUST use them literally.
3. Maintain the technical tone of the conversation.${glossary_str}`;

    const prompt_user = `Translate this text: "${text}"`;

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
    console.error("Error calling OpenAI: - translate.ts:150", error.message);
    return res.status(500).json({ error: "Failed to translate text" });
  }
}
