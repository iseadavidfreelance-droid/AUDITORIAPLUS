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

    const { mission_id, task_id, deposit_code, sku_code, counted_quantity, sales_during_audit } = await req.json();

    if (!mission_id || !task_id || counted_quantity === undefined) {
      return new Response(JSON.stringify({ error: 'Parámetros requeridos faltantes' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const userId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();

    // 1. Obtener la cantidad del sistema actual de la tarea
    const { data: task, error: taskError } = await supabase
      .from('Read_Mission_Tasks')
      .select('SystemQuantity, SkuDescription')
      .eq('TaskId', task_id)
      .single();

    if (taskError || !task) {
      return new Response(JSON.stringify({ error: 'Tarea no encontrada' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const theoreticalQty = Number(task.SystemQuantity) - Number(sales_during_audit || 0);
    const calculatedDiscrepancy = Number(counted_quantity) - theoreticalQty;

    // 2. Escribir evento TaskCountRegistered en EventStore
    const { error: eventError } = await supabase.from('EventStore').insert({
      AggregateId: mission_id,
      AggregateType: 'Mission',
      EventType: 'TaskCountRegistered',
      Payload: {
        mission_id,
        task_id,
        deposit_code,
        sku_code,
        counted_quantity: Number(counted_quantity),
        sales_during_audit: Number(sales_during_audit || 0),
        calculated_discrepancy: calculatedDiscrepancy
      },
      Metadata: { source: 'edge_function_register_count' },
      UserId: userId,
      CorrelationId: correlationId
    });

    if (eventError) throw eventError;

    // 3. Si hay discrepancia, registrar evento DiscrepancyDetected
    if (calculatedDiscrepancy !== 0) {
      await supabase.from('EventStore').insert({
        AggregateId: mission_id,
        AggregateType: 'Mission',
        EventType: 'DiscrepancyDetected',
        Payload: {
          discrepancy_id: crypto.randomUUID(),
          mission_id,
          origin_deposit: deposit_code,
          floor_deposit: '150103',
          sku_code,
          sku_description: task.SkuDescription || '',
          warehouse_discrepancy: calculatedDiscrepancy
        },
        Metadata: { source: 'edge_function_register_count' },
        UserId: userId,
        CorrelationId: correlationId
      });
    }

    return new Response(JSON.stringify({
      success: true,
      task_id,
      calculated_discrepancy: calculatedDiscrepancy
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