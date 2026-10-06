import { createClient } from "npm:@supabase/supabase-js@2.39.3";

console.log("🟢 [1] ISOLATE INICIADO EN DENO 2.1.4 (VERSION BIDIRECCIONAL + LIVE API)");

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
    
    // EXTRAEMOS LOS NUEVOS DATOS ENVIADOS POR EL INTERCEPTOR
    const { 
      mission_id, task_id, deposit_code, sku_code, 
      counted_quantity, system_quantity, sales_during_audit, user_id,
      target_deposit, target_system_quantity 
    } = body;

    const url = Deno.env.get('SUPABASE_URL') || '';
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    const supabaseClient = createClient(url, key);

    // BLINDAJE MATEMÁTICO
    const safeCounted = Number(counted_quantity) || 0;
    const safeSystem = Number(system_quantity) || 0;
    const safeSales = Number(sales_during_audit) || 0;
    const safeTargetSystem = Number(target_system_quantity) || 0;
    
    const calculated_discrepancy = safeCounted - (safeSystem - safeSales);

    // Deducir destino por seguridad si no viene en el payload
    const final_target_deposit = target_deposit || (deposit_code === '150101' ? '150103' : '150101');

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
      Metadata: { client: "PWA_AuditoriaPlus_Interceptor_Live" }
    };

    const { data, error } = await supabaseClient.from('EventStore').insert(payloadToInsert).select();
    if (error) throw new Error("Error Evento Principal: " + error.message);

    if (calculated_discrepancy !== 0) {
      const { error: discError } = await supabaseClient
        .from('EventStore')
        .insert({
          AggregateId: task_id,
          AggregateType: 'CrossDiscrepancy',
          EventType: 'DiscrepancyDetected',
          UserId: user_id,
          CorrelationId: crypto.randomUUID(),
          Payload: {
            discrepancy_id: crypto.randomUUID(),
            mission_id: mission_id,
            origin_deposit: deposit_code,
            target_deposit: final_target_deposit,
            sku_code: sku_code,
            sku_description: "SKU " + sku_code,
            origin_discrepancy: calculated_discrepancy,
            target_system_quantity: safeTargetSystem, // <-- AHORA INYECTA EL STOCK DEL DESTINO EN VIVO
            status: "PENDING_TARGET_COUNT"
          },
          Metadata: { trigger: "auto_discrepancy" }
        });
        
        if (discError) throw new Error("Error Evento Discrepancia: " + discError.message);
    }

    return new Response(
      JSON.stringify({ status: "success", code: 200, data: { task_id, calculated_discrepancy, status: calculated_discrepancy === 0 ? 'COMPLETED_MATCH' : 'DISCREPANT' } }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Error desconocido' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});