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

    const {
      discrepancy_id,
      mission_id,
      sku_code,
      sku_description,
      origin_deposit,
      warehouse_discrepancy,
      floor_counted_qty,
      floor_system_qty
    } = await req.json();

    if (!discrepancy_id || !mission_id || floor_counted_qty === undefined) {
      return new Response(JSON.stringify({ error: 'Parámetros requeridos faltantes' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const userId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();

    const floorDiscrepancy = Number(floor_counted_qty) - Number(floor_system_qty || 0);

    // 1. Escribir Evento FloorCountRegistered en EventStore
    const { error: eventError } = await supabase.from('EventStore').insert({
      AggregateId: mission_id,
      AggregateType: 'Mission',
      EventType: 'FloorCountRegistered',
      Payload: {
        discrepancy_id,
        mission_id,
        floor_counted_qty: Number(floor_counted_qty),
        floor_discrepancy: floorDiscrepancy
      },
      Metadata: { source: 'edge_function_register_floor_count' },
      UserId: userId,
      CorrelationId: correlationId
    });

    if (eventError) throw eventError;

    // 2. Si hay unidades en piso para compensar el faltante de almacén, generar traslado virtual
    const whseDiff = Number(warehouse_discrepancy || 0);
    let transferExecuted = false;
    let transferQty = 0;

    if (whseDiff < 0 && Number(floor_counted_qty) > 0) {
      transferQty = Math.min(Math.abs(whseDiff), Number(floor_counted_qty));

      await supabase.from('EventStore').insert({
        AggregateId: mission_id,
        AggregateType: 'Mission',
        EventType: 'VirtualTransferCreated',
        Payload: {
          transfer_id: crypto.randomUUID(),
          mission_id,
          sku_code,
          sku_description: sku_description || '',
          from_deposit: '150103',
          to_deposit: origin_deposit || '150101',
          transfer_quantity: transferQty,
          transit_deposit: '150104'
        },
        Metadata: { source: 'edge_function_register_floor_count' },
        UserId: userId,
        CorrelationId: correlationId
      });

      transferExecuted = true;
    }

    return new Response(JSON.stringify({
      success: true,
      discrepancy_id,
      floor_discrepancy: floorDiscrepancy,
      virtual_transfer_executed: transferExecuted,
      transfer_quantity: transferQty
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