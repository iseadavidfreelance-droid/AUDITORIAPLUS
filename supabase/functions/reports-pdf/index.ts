import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const url = new URL(req.url);
    const missionId = url.searchParams.get('mission_id');

    if (!missionId) {
      return new Response(JSON.stringify({ error: 'Parámetro mission_id es requerido' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Consultar métricas y datos proyectados
    const { data: mission } = await supabase
      .from('Read_Missions')
      .select('*')
      .eq('MissionId', missionId)
      .single();

    const { data: tasks } = await supabase
      .from('Read_Mission_Tasks')
      .select('*')
      .eq('MissionId', missionId);

    const { data: floorDiscrepancies } = await supabase
      .from('Read_Floor_Discrepancies')
      .select('*')
      .eq('MissionId', missionId);

    const { data: virtualTransfers } = await supabase
      .from('Read_Virtual_Transfers')
      .select('*')
      .eq('MissionId', missionId);

    const reportData = {
      mission,
      total_tasks: tasks?.length || 0,
      discrepancies_count: floorDiscrepancies?.length || 0,
      transfers_count: virtualTransfers?.length || 0,
      generated_at: new Date().toISOString()
    };

    return new Response(JSON.stringify({
      success: true,
      report: reportData
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});