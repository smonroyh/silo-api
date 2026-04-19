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
        const { seconds } = req.body;
        if (!seconds || typeof seconds !== 'number' || seconds <= 0) {
            return res.status(400).json({ error: 'Invalid seconds value' });
        }

        // 3. Mes actual formato "2026-04"
        const month = new Date().toISOString().slice(0, 7);

        // 4. Upsert — si existe el registro del mes lo actualiza, si no lo crea
        // const { error } = await supabase
        //     .from('usage')
        //     .upsert(
        //         {
        //             user_id: user.id,
        //             month,
        //             seconds_used: seconds,
        //             updated_at: new Date().toISOString(),
        //         },
        //         {
        //             onConflict: 'user_id, month',
        //             // Suma los segundos al valor existente
        //             ignoreDuplicates: false,
        //         }
        //     );

        // Supabase upsert no suma automáticamente — usamos rpc para incrementar
        const { error: rpcError } = await supabase.rpc('increment_usage', {
            p_user_id: user.id,
            p_month: month,
            p_seconds: seconds,
        });

        if (rpcError) throw rpcError;

        return res.status(200).json({ success: true });

    } catch (err: any) {
        console.error('Error tracking usage: - track.ts:62', err.message);
        return res.status(500).json({ error: 'Failed to track usage' });
    }
}