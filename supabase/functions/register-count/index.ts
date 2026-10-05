import { createClient } from "npm:@supabase/supabase-js@2.39.3";

console.log("🟢 [1] ISOLATE INICIADO EN DENO 2.1.4");

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin') || '*';
  const requestedHeaders = req.headers.get('Access-Control-Request-Headers') || '*';

  const corsHeaders = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, PUT, DELETE',
    'Access-Control-Allow-Headers': requestedHeaders,
    'Access-Control-Max-Age': '86400',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const bodyText = await req.text();
    const body = JSON.parse(bodyText);
    const { mission_id, task_id, deposit_code, sku_code, counted_quantity, system_quantity, sales_during_audit, user_id } = body;

    const url = Deno.env.get('SUPABASE_URL') || '';
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    const supabaseClient = createClient(url, key);

    // BLINDAJE MATEMÁTICO: Si llega undefined, se convierte en 0 automáticamente.
    const safeCounted = Number(counted_quantity) || 0;
    const safeSystem = Number(system_quantity) || 0;
    const safeSales = Number(sales_during_audit) || 0;
    
    // Cálculo seguro (Jamás será NaN ni null)
    const calculated_discrepancy = safeCounted - (safeSystem - safeSales);

    const payloadToInsert = {
      AggregateId: task_id,
      AggregateType: 'MissionTask',
      EventType: 'TaskCountRegistered',
      UserId: user_id,
      CorrelationId: crypto.randomUUID(),
      Payload: {
        mission_id, task_id, deposit_code, sku_code,
        counted_quantity: safeCounted, 
        system_quantity: safeSystem, 
        sales_during_audit: safeSales, 
        calculated_discrepancy
      },
      Metadata: { client: "PWA_AuditoriaPlus_V5" }
    };

    const { data, error } = await supabaseClient
      .from('EventStore')
      .insert(payloadToInsert)
      .select();

    if (error) throw new Error(error.message);
    console.log("✅ [5] INSERCIÓN EXITOSA EN EVENTSTORE:", data);

    if (calculated_discrepancy !== 0) {
      const { error: discError } = await supabaseClient
        .from('EventStore')
        .insert({
          AggregateId: task_id,
          AggregateType: 'FloorDiscrepancy',
          EventType: 'DiscrepancyDetected',
          UserId: user_id,
          CorrelationId: crypto.randomUUID(),
          Payload: {
            discrepancy_id: crypto.randomUUID(),
            mission_id,
            origin_deposit: deposit_code,
            floor_deposit: "150103",
            sku_code,
            sku_description: "SKU " + sku_code,
            warehouse_discrepancy: calculated_discrepancy,
            status: "PENDING_FLOOR_COUNT"
          },
          Metadata: { trigger: "auto_discrepancy" }
        });
        
        if (discError) throw new Error(discError.message);
        console.log("✅ [6] DISCREPANCIA REGISTRADA.");
    }

    return new Response(
      JSON.stringify({
        status: "success",
        code: 200,
        data: { task_id, calculated_discrepancy, status: calculated_discrepancy === 0 ? 'COMPLETED_MATCH' : 'DISCREPANT' }
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error("🔥 [FATAL] CRASH:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Error desconocido' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});