import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        // 1. Verificar auth
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (!token) return res.status(401).json({ error: 'Missing token' });

        const supabase = createClient(
            process.env.VITE_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!
        );

        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        if (authError || !user) return res.status(401).json({ error: 'Invalid session' });

        // 2. Recibe los segundos a registrar
        const { seconds, tokens } = req.body;
        if (!seconds || typeof seconds !== 'number' || seconds <= 0) {
            return res.status(400).json({ error: 'Invalid seconds value' });
        }

        // 3. Mes actual formato "2026-04"
        const month = new Date().toISOString().slice(0, 7);

        // 3. Registrar Segundos Deepgram
        if (seconds && typeof seconds === 'number' && seconds > 0) {

            const { error: rpcError } = await supabase.rpc('increment_usage', {
                p_user_id: user.id,
                p_month: month,
                p_seconds: seconds,
            });
            if (rpcError) throw rpcError;
        }

        // 4. Registrar Tokens OpenAI 
        if (tokens && typeof tokens === 'number' && tokens > 0) {

            const { error: logError } = await supabase.rpc('increment_usage_openai', {
                p_user_id: user.id,
                p_month: month,
                p_amount: tokens,
            });
            if (logError) throw logError;
        }

        return res.status(200).json({ success: true });

    } catch (err: any) {
        console.error('Error tracking usage: - track.ts:58', err.message);
        return res.status(500).json({ error: 'Failed to track usage' });
    }
}