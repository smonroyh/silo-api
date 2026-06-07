import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

const EMBEDDING_MODEL = 'text-embedding-3-small';
const GENERATION_MODEL = 'gpt-4o-mini';
const RECENT_TURNS = 5; // how many trailing turns of history to keep
const RETRIEVED_CHUNKS = 5; // how many document chunks to feed the model

type Speaker = 'cliente' | 'agente';
interface HistoryTurn { speaker: Speaker; text: string }

/** Strip ```json ... ``` fences and parse, returning null on any failure. */
function safeParseSuggestions(raw: string): string[] | null {
  if (!raw) return null;
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }
  try {
    const parsed = JSON.parse(cleaned);
    const list = Array.isArray(parsed) ? parsed : parsed?.suggestions;
    if (Array.isArray(list)) {
      return list.map((s) => String(s)).filter((s) => s.trim().length > 0);
    }
  } catch {
    /* fall through */
  }
  return null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    // 1. Authenticate with Supabase ------------------------------------------
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Missing Authorization header' });

    const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('Missing Supabase configuration in server - suggestions.ts:52');
      return res.status(500).json({ error: 'Server Configuration Error' });
    }

    const supabase = createSupabaseClient(supabaseUrl, supabaseServiceKey);
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    // 2. Resolve the agent's call center -------------------------------------
    const { data: agente, error: agenteError } = await supabase
      .from('agentes')
      .select('call_center_id')
      .eq('user_id', user.id)
      .single();

    if (agenteError || !agente) {
      return res.status(403).json({ error: 'User is not linked to a call center' });
    }
    const callCenterId = agente.call_center_id;

    // 3. Validate body --------------------------------------------------------
    const { history, targetLang } = (req.body ?? {}) as {
      history?: HistoryTurn[];
      targetLang?: string;
    };
    if (!Array.isArray(history) || history.length === 0) {
      return res.status(400).json({ error: 'Missing conversation history' });
    }
    const lang = (targetLang && String(targetLang).trim()) || 'English';

    // 4. Keep only the last few turns ----------------------------------------
    const recent = history
      .filter((h) => h && typeof h.text === 'string' && h.text.trim())
      .slice(-RECENT_TURNS);
    if (recent.length === 0) {
      return res.status(400).json({ error: 'Conversation history is empty' });
    }

    // 5. Build the retrieval query: prefer the latest client utterance, fall
    //    back to a summary of the recent context.
    const lastClient = [...recent].reverse().find((h) => h.speaker === 'cliente');
    const queryText = (lastClient?.text || recent.map((h) => h.text).join(' ')).slice(0, 2000);

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error('No OPENAI_API_KEY set - suggestions.ts:96');
      return res.status(500).json({ error: 'Server Configuration Error' });
    }
    const openai = new OpenAI({ apiKey });

    // 6. Embed the query and retrieve the most relevant chunks ---------------
    const embedResp = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: queryText });
    const queryEmbedding = embedResp.data[0].embedding as number[];

    const { data: chunks, error: searchError } = await supabase.rpc('buscar_documentos', {
      query_embedding: queryEmbedding,
      p_call_center_id: callCenterId,
      limite: RETRIEVED_CHUNKS,
    });
    if (searchError) throw searchError;

    if (!chunks || chunks.length === 0) {
      // No documents indexed for this call center yet.
      return res.status(200).json({
        suggestions: [],
        message: 'No indexed documents for this call center yet. Ask an admin to upload the official procedures.',
      });
    }

    const context = (chunks as Array<{ contenido: string; nombre_archivo: string | null }>)
      .map((c, i) => `[#${i + 1}${c.nombre_archivo ? ` · ${c.nombre_archivo}` : ''}]\n${c.contenido}`)
      .join('\n\n---\n\n');

    const conversation = recent
      .map((h) => `${h.speaker === 'agente' ? 'Agent' : 'Customer'}: ${h.text}`)
      .join('\n');

    // 7. Build the prompt -----------------------------------------------------
    const systemPrompt = `You are a call center assistant. Generate 3 short, professional and actionable replies in ${lang} for the agent to say to the customer. Base your answers ONLY on these official procedures:

${context}

If the information the agent needs is NOT in the procedures, one of the suggestions must tell the agent to escalate the case to a supervisor.
Return ONLY valid JSON, no markdown: { "suggestions": ["...", "...", "..."] }`;

    const userPrompt = `Recent conversation:\n${conversation}\n\nGenerate the 3 suggested replies now.`;

    // 8. Generate -------------------------------------------------------------
    const completion = await openai.chat.completions.create({
      model: GENERATION_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.5,
      max_tokens: 300,
      response_format: { type: 'json_object' },
    });

    const raw = completion.choices[0]?.message?.content || '';
    const suggestions = safeParseSuggestions(raw);

    // 9. Handle a model that did not return parseable JSON -------------------
    if (!suggestions || suggestions.length === 0) {
      console.error('Could not parse suggestions JSON - suggestions.ts:152', raw.slice(0, 200));
      return res.status(200).json({
        suggestions: [],
        error: 'Could not generate suggestions. Please try again.',
      });
    }

    return res.status(200).json({ suggestions: suggestions.slice(0, 3) });

  } catch (error: any) {
    console.error('Error generating suggestions - suggestions.ts:162', error?.message);
    return res.status(500).json({ error: 'Failed to generate suggestions' });
  }
}
