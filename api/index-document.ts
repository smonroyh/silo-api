import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
// pdf-parse@1.x ships a debug harness in its index.js that tries to read a
// bundled test PDF when `module.parent` is falsy (which happens once the
// function is bundled for serverless). Importing the internal lib entry skips
// that harness and just gives us the parser.
// @ts-ignore - no type declarations for pdf-parse's internal lib entry point
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

// NOTE: the PDF arrives base64-encoded inside the JSON body. Vercel caps the
// request body at ~4.5 MB platform-wide (not configurable for plain Node
// functions), so the client must keep the raw PDF under ~3.4 MB; larger files
// hit the 413 path below. Duration/memory are set in the root vercel.json.

const EMBEDDING_MODEL = 'text-embedding-3-small';
const CHUNK_WORDS = 500;
const OVERLAP_WORDS = 50;
const EMBED_BATCH = 100; // chunks per OpenAI embeddings request

/** Split text into ~CHUNK_WORDS word chunks with OVERLAP_WORDS of overlap. */
function chunkText(text: string): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const step = CHUNK_WORDS - OVERLAP_WORDS; // 450
  const chunks: string[] = [];
  for (let start = 0; start < words.length; start += step) {
    const chunk = words.slice(start, start + CHUNK_WORDS).join(' ').trim();
    if (chunk) chunks.push(chunk);
    if (start + CHUNK_WORDS >= words.length) break; // last window reached
  }
  return chunks;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // 1. Authenticate with Supabase ------------------------------------------
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Missing Authorization header' });

    const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('Missing Supabase configuration in server - index-document.ts:62');
      return res.status(500).json({ error: 'Server Configuration Error' });
    }

    const supabase = createSupabaseClient(supabaseUrl, supabaseServiceKey);
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    // 2. The user must be an ADMIN of a call center --------------------------
    const { data: agente, error: agenteError } = await supabase
      .from('agentes')
      .select('call_center_id, rol')
      .eq('user_id', user.id)
      .single();

    if (agenteError || !agente) {
      return res.status(403).json({ error: 'User is not linked to a call center' });
    }
    if (agente.rol !== 'admin') {
      return res.status(403).json({ error: 'Only call center admins can manage documents' });
    }
    const callCenterId = agente.call_center_id;

    // 3a. DELETE: remove every chunk of a document ---------------------------
    if (req.method === 'DELETE') {
      const nombreArchivo = (req.body?.nombre_archivo ?? req.query?.nombre_archivo) as string | undefined;
      if (!nombreArchivo) {
        return res.status(400).json({ error: 'Missing nombre_archivo' });
      }

      const { error: deleteError, count } = await supabase
        .from('documentos')
        .delete({ count: 'exact' })
        .eq('call_center_id', callCenterId)
        .eq('nombre_archivo', nombreArchivo);

      if (deleteError) throw deleteError;
      return res.status(200).json({ success: true, deleted: count ?? 0, nombre_archivo: nombreArchivo });
    }

    // 3b. POST: index a new PDF ----------------------------------------------
    const { fileName, fileBase64 } = req.body ?? {};
    if (!fileName || typeof fileName !== 'string') {
      return res.status(400).json({ error: 'Missing fileName' });
    }
    if (!fileBase64 || typeof fileBase64 !== 'string') {
      return res.status(400).json({ error: 'Missing fileBase64 (base64-encoded PDF)' });
    }

    // Accept both raw base64 and data URLs (data:application/pdf;base64,....)
    const base64 = fileBase64.includes(',') ? fileBase64.split(',').pop()! : fileBase64;
    let pdfBuffer: Buffer;
    try {
      pdfBuffer = Buffer.from(base64, 'base64');
    } catch {
      return res.status(400).json({ error: 'Invalid base64 payload' });
    }
    if (pdfBuffer.length === 0) {
      return res.status(400).json({ error: 'Empty file' });
    }

    // 4. Extract text from the PDF -------------------------------------------
    let extractedText = '';
    try {
      const parsed = await pdfParse(pdfBuffer);
      extractedText = (parsed?.text || '').trim();
    } catch (err: any) {
      console.error('PDF parse error - index-document.ts:124', err?.message);
      return res.status(422).json({
        error: 'Could not read this PDF. It may be corrupted or password-protected.',
      });
    }

    if (extractedText.length < 20) {
      // No usable text layer -> almost certainly a scanned/image PDF.
      return res.status(422).json({
        error: 'No extractable text found. This PDF looks scanned — run it through OCR (e.g. searchable PDF) before uploading.',
      });
    }

    // 5. Chunk the text -------------------------------------------------------
    const chunks = chunkText(extractedText);
    if (chunks.length === 0) {
      return res.status(422).json({ error: 'No text chunks produced from this PDF.' });
    }

    // 6. Generate embeddings in batches --------------------------------------
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error('No OPENAI_API_KEY set - index-document.ts:146');
      return res.status(500).json({ error: 'Server Configuration Error' });
    }
    const openai = new OpenAI({ apiKey });

    const embeddings: number[][] = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH);
      const resp = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: batch });
      // The API preserves input order in resp.data.
      for (const item of resp.data) embeddings.push(item.embedding as number[]);
    }

    // 7. Persist every chunk with its embedding + metadata -------------------
    const rows = chunks.map((contenido, index) => ({
      call_center_id: callCenterId,
      nombre_archivo: fileName,
      contenido,
      embedding: embeddings[index],
      metadata: { nombre_archivo: fileName, chunk_index: index, total_chunks: chunks.length },
    }));

    // Insert in batches to keep each statement small.
    const INSERT_BATCH = 100;
    for (let i = 0; i < rows.length; i += INSERT_BATCH) {
      const { error: insertError } = await supabase
        .from('documentos')
        .insert(rows.slice(i, i + INSERT_BATCH));
      if (insertError) throw insertError;
    }

    // 8. Summary -------------------------------------------------------------
    return res.status(200).json({
      success: true,
      nombre_archivo: fileName,
      chunks: chunks.length,
      characters: extractedText.length,
    });

  } catch (error: any) {
    // Vercel rejects bodies over ~4.5 MB before they reach us, but guard anyway.
    if (error?.statusCode === 413 || error?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'PDF too large. Split it into smaller files (< ~3 MB each).' });
    }
    console.error('Error indexing document - index-document.ts:188', error?.message);
    return res.status(500).json({ error: 'Failed to index document' });
  }
}
