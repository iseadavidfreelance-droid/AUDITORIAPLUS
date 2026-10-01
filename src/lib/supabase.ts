/**
 * AUDITORIAPLUS+ - Cliente Oficial de Supabase
 * Conexión directa a la instancia PostgreSQL y Edge Functions.
 * PROHIBIDO EL USO DE DATOS MOCK O SIMULADOS.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

const rawUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const rawAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

const sanitizedUrl = rawUrl?.trim() ?? '';
const sanitizedKey = rawAnonKey?.trim() ?? '';

export const supabaseUrl: string = sanitizedUrl;
export const supabaseAnonKey: string = sanitizedKey;

export const isSupabaseConfigured: boolean = Boolean(
  sanitizedUrl &&
  sanitizedKey &&
  sanitizedUrl !== 'https://your-project.supabase.co' &&
  !sanitizedUrl.includes('placeholder')
);

if (!isSupabaseConfigured) {
  console.warn(
    '[AUDITORIAPLUS+] Variables de entorno VITE_SUPABASE_URL o VITE_SUPABASE_ANON_KEY no configuradas o con valores de plantilla. ' +
    'Configure las credenciales reales de Supabase en su archivo .env para sincronizar con la base de datos PostgreSQL y Edge Functions.'
  );
}

// Inicialización de cliente con fallback seguro para prevenir fallos inmediatos de instanciación
export const supabase: SupabaseClient = createClient(
  isSupabaseConfigured ? sanitizedUrl : 'https://placeholder.supabase.co',
  isSupabaseConfigured ? sanitizedKey : 'placeholder-anon-key',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
    realtime: {
      params: {
        eventsPerSecond: 10,
      },
    },
    global: {
      headers: {
        'x-application-name': 'AUDITORIAPLUS-PWA',
        'x-client-version': '1.0.0',
      },
    },
  }
);

/**
 * Invoca una función Edge de Supabase de manera tipada y con gestión de errores
 */
export async function invokeEdgeFunction<TResponse = unknown, TBody = unknown>(
  functionName: string,
  body?: TBody,
  headers?: Record<string, string>
): Promise<{ data: TResponse | null; error: Error | null; status: number }> {
  try {
    if (!isSupabaseConfigured) {
      throw new Error(
        `Supabase no está configurado. No se puede invocar la Edge Function "${functionName}". Configure VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY.`
      );
    }

    const { data, error } = await supabase.functions.invoke<TResponse>(functionName, {
      body: body as Record<string, unknown>,
      headers: {
        ...headers,
      },
    });

    if (error) {
      return {
        data: null,
        error: new Error(error.message || `Error al invocar ${functionName}`),
        status: (error as { status?: number }).status ?? 500,
      };
    }

    return {
      data,
      error: null,
      status: 200,
    };
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    return {
      data: null,
      error,
      status: 500,
    };
  }
}

/**
 * Verifica la conectividad con la base de datos de Supabase
 */
export async function checkSupabaseConnection(): Promise<{ connected: boolean; latencyMs: number; error?: string }> {
  if (!isSupabaseConfigured) {
    return {
      connected: false,
      latencyMs: 0,
      error: 'VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY no han sido configuradas.',
    };
  }

  const start = performance.now();
  try {
    // Consulta ligera al Read Model de Misiones
    const { error } = await supabase.from('Read_Missions').select('MissionId').limit(1);
    const latencyMs = Math.round(performance.now() - start);

    if (error) {
      // Incluso si la tabla estuviese vacía o con RLS, valida que hubo comunicación con el endpoint
      if (error.code === 'PGRST116' || error.message.includes('permission denied')) {
        return { connected: true, latencyMs };
      }
      return { connected: false, latencyMs, error: error.message };
    }

    return { connected: true, latencyMs };
  } catch (err: unknown) {
    const latencyMs = Math.round(performance.now() - start);
    return {
      connected: false,
      latencyMs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
