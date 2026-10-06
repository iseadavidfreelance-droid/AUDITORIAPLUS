import { createClient } from "npm:@supabase/supabase-js@2.39.3";

console.log("🟢 [1] INICIANDO: register-floor-count (CQRS Puro + Bidireccional)");

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

    // EXTRAEMOS LAS VARIABLES (Soportando la estructura vieja y la nueva de la PWA)
    const {
      discrepancy_id,
      mission_id,
      sku_code,
      sku_description,
      origin_deposit,
      target_deposit,
      origin_discrepancy, // Nueva variable agnóstica
      warehouse_discrepancy, // Variable Legacy
      target_counted_quantity, // Nueva variable agnóstica
      floor_counted_qty, // Variable Legacy
      target_system_quantity, // Nueva variable agnóstica
      floor_system_qty, // Variable Legacy
      user_id // ID Real extraído del AuthStore
    } = body;

    // Normalización de seguridad para no perder datos si el Frontend usa nombres viejos o nuevos
    const finalCountedQty = target_counted_quantity ?? floor_counted_qty;
    const finalSystemQty = target_system_quantity ?? floor_system_qty ?? 0;
    const finalOriginDisc = origin_discrepancy ?? warehouse_discrepancy ?? 0;

    if (!discrepancy_id || !mission_id || finalCountedQty === undefined) {
      return new Response(JSON.stringify({ error: 'Parámetros requeridos faltantes' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Respetamos tu asignación de IDs y fallbacks
    const userId = user_id || crypto.randomUUID();
    const correlationId = crypto.randomUUID();

    // CÁLCULO MATEMÁTICO DEL DESTINO
    const targetCount = Number(finalCountedQty);
    const targetSys = Number(finalSystemQty);
    const targetDiscrepancy = targetCount - targetSys;

    // 1. Escribir Evento FloorCountRegistered en EventStore (Respetando tu AggregateType)
    const { error: eventError } = await supabase.from('EventStore').insert({
      AggregateId: mission_id,
      AggregateType: 'Mission',
      EventType: 'FloorCountRegistered',
      Payload: {
        discrepancy_id,
        mission_id,
        // Enviamos nombres legacy y agnósticos para 0% probabilidad de ruptura en tu Trigger
        floor_counted_qty: targetCount,
        floor_discrepancy: targetDiscrepancy,
        target_system_quantity: targetSys,
        target_counted_quantity: targetCount,
        target_discrepancy: targetDiscrepancy
      },
      Metadata: { source: 'edge_function_register_floor_count_v2' },
      UserId: userId,
      CorrelationId: correlationId
    });

    if (eventError) throw new Error("Fallo al registrar evento de conteo: " + eventError.message);

    // 2. Lógica Bidireccional de Traslado Sugerido
    const originDiscNum = Number(finalOriginDisc);
    let transferExecuted = false; // Mantenemos el nombre de tu variable para el HTTP Response
    let transferQty = 0;
    let fromDep = '';
    let toDep = '';

    // Condición A: Falta en Origen y Sobra en Destino
    if (originDiscNum < 0 && targetDiscrepancy > 0) {
      transferQty = Math.min(Math.abs(originDiscNum), targetDiscrepancy);
      fromDep = target_deposit || '150103';
      toDep = origin_deposit || '150101';
    } 
    // Condición B: Sobra en Origen y Falta en Destino (Soporte para Misión Inversa)
    else if (originDiscNum > 0 && targetDiscrepancy < 0) {
      transferQty = Math.min(originDiscNum, Math.abs(targetDiscrepancy));
      fromDep = origin_deposit || '150101';
      toDep = target_deposit || '150103';
    }

    if (transferQty > 0) {
      const newTransferId = crypto.randomUUID();
      
      await supabase.from('EventStore').insert({
        AggregateId: mission_id,
        AggregateType: 'Mission',
        EventType: 'VirtualTransferCreated',
        Payload: {
          transfer_id: newTransferId,
          mission_id,
          sku_code,
          sku_description: sku_description || '',
          from_deposit: fromDep,
          to_deposit: toDep,
          transfer_quantity: transferQty,
          transit_deposit: '150104',
          status: 'SUGGESTED' // <-- Estatus clave para que requiera confirmación humana
        },
        Metadata: { source: 'edge_function_register_floor_count_v2' },
        UserId: userId,
        CorrelationId: correlationId
      });

      transferExecuted = true;
    }

    // Respuesta HTTP idéntica a la tuya para no romper el Frontend
    return new Response(JSON.stringify({
      success: true,
      discrepancy_id,
      floor_discrepancy: targetDiscrepancy,
      virtual_transfer_executed: transferExecuted,
      transfer_quantity: transferQty
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