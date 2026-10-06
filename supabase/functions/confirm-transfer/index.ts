import { createClient } from "npm:@supabase/supabase-js@2.39.3";

console.log("🟢 [1] INICIANDO: confirm-transfer (CQRS Puro)");

Deno.serve(async (req) => {
  // --- ESPEJO CORS ABSOLUTO ---
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
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const bodyText = await req.text();
    const body = JSON.parse(bodyText);

    const {
      transfer_id,
      mission_id,
      sku_code,
      user_id
    } = body;

    if (!transfer_id || !mission_id || !sku_code) {
      return new Response(JSON.stringify({ error: 'Parámetros requeridos faltantes' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const userId = user_id || crypto.randomUUID();
    const correlationId = crypto.randomUUID();

    // CQRS PURO: Escribir Evento Inmutable en EventStore
    // Respetamos AggregateId: mission_id para mantener el hilo de tu BD actual
    const { error: eventError } = await supabase.from('EventStore').insert({
      AggregateId: mission_id,
      AggregateType: 'Mission',
      EventType: 'VirtualTransferExecuted', // NUEVO EVENTO PARA CONFIRMACIÓN
      Payload: {
        transfer_id,
        mission_id,
        sku_code,
        status: 'EXECUTED',
        manual_confirmation: true
      },
      Metadata: { source: 'edge_function_confirm_transfer' },
      UserId: userId,
      CorrelationId: correlationId
    });

    if (eventError) throw new Error("Fallo al registrar evento de confirmación: " + eventError.message);

    return new Response(JSON.stringify({
      success: true,
      transfer_id,
      status: 'EXECUTED'
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });

  } catch (err: any) {
    console.error("🔥 [FATAL] CRASH:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    });
  }
});