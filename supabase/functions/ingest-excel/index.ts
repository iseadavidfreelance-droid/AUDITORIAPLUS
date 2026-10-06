import { createClient } from "npm:@supabase/supabase-js@2.39.3";
import * as XLSX from "npm:xlsx@0.18.5";

console.log("🟢 [1] INGEST-EXCEL INICIADO EN DENO 2.x - UN SOLO ARCHIVO");

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin') || '*';
  const requestedHeaders = req.headers.get('Access-Control-Request-Headers') || '*';

  const corsHeaders = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': requestedHeaders,
    'Access-Control-Max-Age': '86400',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    console.log("📥 [2] RECIBIENDO PETICIÓN...");
    const url = Deno.env.get('SUPABASE_URL') || '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    const supabaseAdmin = createClient(url, serviceKey);

    const authHeader = req.headers.get('Authorization') || '';
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
    const supabaseUser = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await supabaseUser.auth.getUser();
    const userId = user?.id || '00000000-0000-0000-0000-000000000000';

    const formData = await req.formData();
    const fileA = formData.get('file_a') as File;
    const depositCode = formData.get('deposit_code') as string || '150101';
    const missionName = formData.get('mission_name') as string || 'Auditoria Generada';

    if (!fileA) throw new Error("Falta el Archivo Excel en la petición");

    console.log("📦 [3] PROCESANDO HASH SHA-256...");
    const arrayBufferA = await fileA.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBufferA);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const excelHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    const { data: existingLog } = await supabaseAdmin
      .from('Read_IngestionLogs')
      .select('IngestionId')
      .eq('ExcelHashSHA256', excelHash)
      .maybeSingle();

    if (existingLog) {
      return new Response(JSON.stringify({ error: "Este archivo Excel ya fue procesado." }), { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const workbook = XLSX.read(arrayBufferA, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const rawData = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "" });

    const missionId = crypto.randomUUID();
    console.log(`🚀 [4] PARSEANDO Y DEDUPLICANDO ${rawData.length} FILAS...`);

    const taskMap = new Map<string, any>();
    
    rawData.forEach((row: any) => {
        const keys = Object.keys(row);
        if (keys.length === 0) return;

        const getVal = (exactMatches: string[], partialMatches: string[]) => {
            let foundKey = keys.find(k => exactMatches.includes(k.trim()));
            if (!foundKey) {
                foundKey = keys.find(k => partialMatches.some(kw => k.toLowerCase().includes(kw)));
            }
            return foundKey ? row[foundKey] : undefined;
        };

        const skuRaw = getVal(['Codigo_Producto'], ['codigo_producto', 'sku', 'cod']);
        const descRaw = getVal(['Producto'], ['producto', 'desc', 'nom']);
        const qtyRaw = getVal(['Existencia'], ['existencia', 'cant', 'stock']);
        const costRaw = getVal(['Costo'], ['costo', 'prec']);

        let normalizedSku = String(skuRaw ?? '').trim();
        if (!normalizedSku || normalizedSku === 'undefined' || normalizedSku === '') return; 

        if (/^\d{1,5}$/.test(normalizedSku)) {
            normalizedSku = normalizedSku.padStart(6, '0');
        }

        const numQty = Number(qtyRaw) || 0;
        const numCost = Number(costRaw) || 0;

        if (taskMap.has(normalizedSku)) {
            const existing = taskMap.get(normalizedSku);
            existing.SystemQuantity += numQty;
        } else {
            taskMap.set(normalizedSku, {
                TaskId: crypto.randomUUID(),
                MissionId: missionId,
                DepositCode: depositCode,
                SkuCode: normalizedSku,
                SkuDescription: String(descRaw || 'Sin descripción').trim(),
                SystemQuantity: numQty,
                Cost: numCost,
                SalesDuringAudit: 0,
                Status: 'PENDING',
                IsFichaComplete: true,
                Barcodes: []
            });
        }
    });

    const tasksToInsert = Array.from(taskMap.values());
    const totalSkus = tasksToInsert.length;

    if (totalSkus === 0) throw new Error("No se encontraron SKUs válidos en el archivo.");

    console.log(`🧹 SKUs únicos validados: ${totalSkus}`);

    // ORDEN ESTRICTO PARA EVITAR LLAVE FORÁNEA:

    console.log("💾 [5] INSERTANDO LOG DE INGESTA...");
    const { error: logError } = await supabaseAdmin.from('Read_IngestionLogs').insert({
        IngestionId: crypto.randomUUID(),
        MissionId: missionId,
        ExcelHashSHA256: excelHash,
        FileName: fileA.name,
        ProcessedRows: totalSkus,
        IngestedBy: userId
    });
    if (logError) throw new Error("Fallo IngestionLog: " + logError.message);

    // ESTO ES LO QUE OMITÍ EN LA VERSIÓN ANTERIOR. CREA LA MISIÓN FÍSICAMENTE.
    console.log("💾 [6] CREANDO MISIÓN EN LA BASE DE DATOS...");
    const { error: missionError } = await supabaseAdmin.from('Read_Missions').insert({
        MissionId: missionId,
        Name: missionName,
        DepositCode: depositCode,
        ExcelHashSHA256: excelHash,
        Status: 'IN_PROGRESS',
        TotalSkus: totalSkus,
        PendingSkus: totalSkus,
        CountedSkus: 0,
        DiscrepantSkus: 0,
        ReconciledSkus: 0
    });
    if (missionError) {
        // Si falla, hacemos rollback del log para evitar falsos positivos
        await supabaseAdmin.from('Read_IngestionLogs').delete().eq('ExcelHashSHA256', excelHash);
        throw new Error("Fallo Mision: " + missionError.message);
    }

    console.log("💾 [7] DISPARANDO EVENTO MISSION_CREATED...");
    const { error: eventError } = await supabaseAdmin.from('EventStore').insert({
        AggregateId: missionId,
        AggregateType: 'Mission',
        EventType: 'MissionCreated',
        UserId: userId,
        CorrelationId: crypto.randomUUID(),
        Payload: { 
          mission_id: missionId, 
          name: missionName, 
          deposit_code: depositCode, 
          excel_hash_sha256: excelHash, 
          total_skus: totalSkus,
          created_by: userId
        },
        Metadata: { source: "excel_ingestion" }
    });
    if (eventError) throw new Error("Fallo EventStore: " + eventError.message);

    console.log("💾 [8] INSERTANDO TAREAS BATCH...");
    const chunkSize = 500;
    for (let i = 0; i < tasksToInsert.length; i += chunkSize) {
        const chunk = tasksToInsert.slice(i, i + chunkSize);
        // Como la Misión ya existe arriba (paso 6), la llave foránea se cumple siempre.
        const { error: tasksError } = await supabaseAdmin.from('Read_Mission_Tasks').insert(chunk);
        if (tasksError) throw new Error("Fallo Tareas: " + tasksError.message); 
    }

    console.log("✅ [9] INGESTA COMPLETADA EXITOSAMENTE");
    
    return new Response(
      JSON.stringify({ status: "success", data: { mission_id: missionId, total_tasks: totalSkus } }),
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