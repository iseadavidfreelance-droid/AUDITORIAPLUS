import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";

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

    const formData = await req.formData();
    const fileA = formData.get('file_a') as File;
    const fileB = formData.get('file_b') as File;
    const depositCode = formData.get('deposit_code') as string || '150101';
    const missionName = formData.get('mission_name') as string || 'Misión Auditar';

    if (!fileA || !fileB) {
      return new Response(JSON.stringify({ error: 'Archivos file_a (Taxonomía) y file_b (Costos) son requeridos' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 1. Obtener buffers de ambos archivos
    const bufferA = await fileA.arrayBuffer();
    const bufferB = await fileB.arrayBuffer();

    // 2. Calcular Hash SHA-256 Combinado (Archivo A + Archivo B)
    const combinedBuffer = new Uint8Array(bufferA.byteLength + bufferB.byteLength);
    combinedBuffer.set(new Uint8Array(bufferA), 0);
    combinedBuffer.set(new Uint8Array(bufferB), bufferA.byteLength);
    
    const hashBuffer = await crypto.subtle.digest('SHA-256', combinedBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const excelHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    // 3. Validar Duplicado en Read_IngestionLogs (Evitar misiones repetidas)
    const { data: existingLog } = await supabase
      .from('Read_IngestionLogs')
      .select('IngestionId')
      .eq('ExcelHashSHA256', excelHash)
      .single();

    if (existingLog) {
      return new Response(JSON.stringify({ error: 'Este conjunto de archivos ya fue procesado anteriormente (Hash Duplicado).' }), {
        status: 409,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 4. Parsear ambos archivos en memoria
    const wbA = XLSX.read(bufferA, { type: 'buffer' });
    const rowsA = XLSX.utils.sheet_to_json(wbA.Sheets[wbA.SheetNames[0]]);

    const wbB = XLSX.read(bufferB, { type: 'buffer' });
    const rowsB = XLSX.utils.sheet_to_json(wbB.Sheets[wbB.SheetNames[0]]);

    // 5. Crear Diccionario ultrarrápido de Costos y Stock (Archivo B)
    const costAndStockMap = new Map();
    for (const row of rowsB as any[]) {
      const sku = String(row['Codigo_Producto'] || row['Codigo'] || '').trim();
      if (sku) {
        costAndStockMap.set(sku, {
          costo: parseFloat(row['Costo']) || 0,
          existencia: parseFloat(row['Existencia']) || 0
        });
      }
    }

    const missionId = crypto.randomUUID();
    // UUID dummy para el backend process
    const userId = '00000000-0000-0000-0000-000000000000'; 
    const tasksToInsert = [];

    // 6. Cruzar Archivo A con Archivo B y aplicar reglas de negocio
    for (const row of rowsA as any[]) {
      const rawSku = String(row['Codigo_Producto'] || row['Codigo'] || '').trim();
      
      // Si la fila está vacía, omitir
      if (!rawSku || rawSku === 'undefined') continue;

      // Regla LPAD: Rellenar a 6 dígitos si es puramente numérico
      const skuCode = /^\d{1,5}$/.test(rawSku) ? rawSku.padStart(6, '0') : rawSku;
      const description = String(row['Producto'] || row['Descripcion'] || 'Sin Descripción').trim();

      // Buscar contra el mapa B
      const bData = costAndStockMap.get(rawSku) || costAndStockMap.get(skuCode);
      const systemQuantity = bData ? bData.existencia : (parseFloat(row['Existencia']) || 0);
      const cost = bData ? bData.costo : 0;

      // Armar la tarea exactamente con las columnas de Read_Mission_Tasks
      tasksToInsert.push({
        MissionId: missionId,
        DepositCode: depositCode,
        SkuCode: skuCode,
        SkuDescription: description,
        Barcodes: [skuCode], // Guardado como JSONB
        Cost: cost,
        SystemQuantity: systemQuantity,
        SalesDuringAudit: 0,
        Status: 'PENDING',
        IsFichaComplete: true
      });
    }

    const totalSkus = tasksToInsert.length;
    if (totalSkus === 0) {
      throw new Error("No se encontraron SKUs válidos. Asegúrate de que las cabeceras se llamen 'Codigo_Producto', 'Producto', 'Costo' y 'Existencia'.");
    }

    // ==========================================
    // EJECUCIÓN SECUENCIAL DE INSERCIONES
    // ==========================================

    // A. Registrar Bitácora de Ingesta
    const { error: logError } = await supabase.from('Read_IngestionLogs').insert({
      MissionId: missionId,
      ExcelHashSHA256: excelHash,
      FileName: fileA.name,
      ProcessedRows: totalSkus,
      IngestedBy: userId
    });
    if (logError) throw new Error(`Fallo Logs: ${logError.message}`);

    // B. Insertar Evento en EventStore
    // IMPORTANTE: Esto dispara automáticamente el trigger 'trg_project_events'
    // que creará el registro maestro en 'Read_Missions'
    const { error: eventError } = await supabase.from('EventStore').insert({
      AggregateId: missionId,
      AggregateType: 'Mission',
      EventType: 'MissionCreated',
      Version: 1,
      Payload: {
        mission_id: missionId,
        name: missionName,
        deposit_code: depositCode,
        excel_hash_sha256: excelHash,
        total_skus: totalSkus
      },
      Metadata: { source: 'edge_function_ingest', method: 'XLSX' },
      UserId: userId,
      CorrelationId: crypto.randomUUID()
    });
    if (eventError) throw new Error(`Fallo EventStore: ${eventError.message}`);

    // C. Insertar Tareas Individuales de Conteo en Read_Mission_Tasks
    const { error: tasksError } = await supabase.from('Read_Mission_Tasks').insert(tasksToInsert);
    if (tasksError) throw new Error(`Fallo Tareas: ${tasksError.message}`);

    return new Response(JSON.stringify({ 
      success: true, 
      mission_id: missionId, 
      excel_hash_sha256: excelHash,
      total_tasks: totalSkus
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 201,
    });

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});