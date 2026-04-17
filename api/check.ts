import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const DEFAULT_LIMIT_SECONDS = 3600; // 1 hora

export default async function handler(req: VercelRequest, res: VercelResponse) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (!token) return res.status(401).json({ error: 'Missing token' });

        const supabase = createClient(
            process.env.VITE_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!
        );

        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        if (authError || !user) return res.status(401).json({ error: 'Invalid session' });

        const month = new Date().toISOString().slice(0, 7);

        // Obtiene uso actual del mes
        const { data: usageData } = await supabase
            .from('usage')
            .select('seconds_used')
            .eq('user_id', user.id)
            .eq('month', month)
            .single();

        // Obtiene límite del usuario
        const { data: limitData } = await supabase
            .from('usage_limits')
            .select('limit_seconds')
            .eq('user_id', user.id)
            .single();

        const secondsUsed = usageData?.seconds_used ?? 0;
        const limitSeconds = limitData?.limit_seconds ?? DEFAULT_LIMIT_SECONDS;
        const secondsRemaining = Math.max(0, limitSeconds - secondsUsed);
        const hasReachedLimit = secondsUsed >= limitSeconds;

        return res.status(200).json({
            seconds_used: secondsUsed,
            limit_seconds: limitSeconds,
            seconds_remaining: secondsRemaining,
            has_reached_limit: hasReachedLimit,
            // útil para mostrar en UI
            hours_used: +(secondsUsed / 3600).toFixed(2),
            hours_limit: +(limitSeconds / 3600).toFixed(2),
        });

    } catch (err: any) {
        console.error('Error checking usage: - check.ts:58', err.message);
        return res.status(500).json({ error: 'Failed to check usage' });
    }
}