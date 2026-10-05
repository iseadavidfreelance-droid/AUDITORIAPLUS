import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // 1. Manejo de CORS (Pre-vuelo)
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  console.log("=== 1. INICIANDO EDGE FUNCTION ===");

  try {
    // 2. Extraer Body de forma segura
    const bodyText = await req.text();
    console.log("=== 2. BODY RECIBIDO ===", bodyText);
    const body = JSON.parse(bodyText);

    const { mission_id, task_id, deposit_code, sku_code, counted_quantity, system_quantity, sales_during_audit, user_id } = body;

    // 3. Conexión a Supabase (BYPASS RLS TEMPORAL CON SERVICE ROLE)
    console.log("=== 3. CONECTANDO A SUPABASE (SERVICE ROLE) ===");
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '' // <-- Llave maestra para garantizar escritura
    )

    const calculated_discrepancy = counted_quantity - (system_quantity - sales_during_audit);

    console.log("=== 4. INTENTANDO INSERTAR EN EVENTSTORE ===");
    
    // Objeto estricto en minúsculas (PostgreSQL default)
    const payloadToInsert = {
      aggregateid: task_id,
      aggregatetype: 'MissionTask',
      eventtype: 'TaskCountRegistered',
      userid: user_id,
      correlationid: crypto.randomUUID(),
      payload: {
        mission_id, task_id, deposit_code, sku_code,
        counted_quantity, system_quantity, sales_during_audit, calculated_discrepancy
      },
      metadata: { client: "PWA_AuditoriaPlus_V2" }
    };

    // Insertar y solicitar confirmación de la data insertada (.select)
    const { data: mainData, error: insertError } = await supabaseClient
      .from('EventStore')
      .insert(payloadToInsert)
      .select();

    if (insertError) {
      console.error("=== ❌ ERROR BD PRINCIPAL ===", insertError);
      throw new Error(insertError.message);
    }

    console.log("=== 5. EVENTO PRINCIPAL INSERTADO OK ===", mainData);

    // 6. Si hay discrepancia, insertar evento secundario
    if (calculated_discrepancy !== 0) {
      console.log("=== 6. INSERTANDO DISCREPANCIA ===");
      const { error: discError } = await supabaseClient
        .from('EventStore')
        .insert({
          aggregateid: task_id,
          aggregatetype: 'FloorDiscrepancy',
          eventtype: 'DiscrepancyDetected',
          userid: user_id,
          correlationid: crypto.randomUUID(),
          payload: {
            discrepancy_id: crypto.randomUUID(),
            mission_id,
            origin_deposit: deposit_code,
            floor_deposit: "150103",
            sku_code,
            sku_description: "SKU " + sku_code,
            warehouse_discrepancy: calculated_discrepancy,
            status: "PENDING_FLOOR_COUNT"
          },
          metadata: { trigger: "auto_discrepancy_system" }
        });
        
        if (discError) {
          console.error("=== ❌ ERROR BD DISCREPANCIA ===", discError);
          throw new Error(discError.message);
        }
    }

    console.log("=== 7. FINALIZADO CON ÉXITO ===");
    return new Response(
      JSON.stringify({
        status: "success",
        code: 200,
        data: {
          task_id,
          calculated_discrepancy,
          status: calculated_discrepancy === 0 ? 'COMPLETED_MATCH' : 'DISCREPANT'
        }
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )

  } catch (error) {
    console.error("=== ❌ CRASH FATAL CAPTURADO ===", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Error critico" }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
    )
  }
})