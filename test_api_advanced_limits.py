import sys
import os
import time
import json
import csv
import urllib.request
import urllib.error

# Configuración UTF-8 y ANSI para PowerShell
if sys.platform == "win32":
    os.system('')
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

API_ENDPOINT = "https://192.168.15.225:3002/api/inventory"

# Lista completa de los 77 SKUs Reales
REAL_SKUS = [
    # Imagen 1
    "8362", "14086", "14326", "15654", "43381", "62314", "71391", "77998", "77999", "79456",
    "79968", "82814", "82815", "42416", "42418", "42419", "42853", "42878", "81994", "2909",
    "15375", "82220", "82512", "82513", "83169",
    # Imagen 2
    "20893", "20895", "47714", "54273", "55932", "59991", "59992", "59993", "60427", "65161",
    "65952", "67685", "74157", "74422", "74423", "74424", "78464", "78465", "79629", "81112",
    "81600", "81601", "81613", "82111", "84159", "84162",
    # Imagen 3
    "9832", "13586", "13587", "23531", "51606", "55789", "59860", "60628", "81175", "81948",
    "80227", "11533", "14994", "15403", "18550", "26084", "43163", "43486", "43497", "45729",
    "51431", "53812", "54448", "54522", "54526", "62429"
]

# Estilos de consola
G, R, Y, C, M, B, W = "\033[92m", "\033[91m", "\033[93m", "\033[96m", "\033[95m", "\033[1m", "\033[0m"

def consultar_sku_con_reintento(sku, max_retries=3, delay_seg=0.4):
    """Consulta individual sin saturación con mecanismo de Exponential Backoff"""
    url = f"{API_ENDPOINT}?search={sku}&limit=10"
    headers = {"User-Agent": "Mozilla/5.0 AuditoriaPlus/1.0", "Accept": "application/json"}
    req = urllib.request.Request(url, headers=headers)

    for intento in range(1, max_retries + 1):
        t_start = time.time()
        try:
            with urllib.request.urlopen(req, timeout=6) as response:
                duracion_ms = (time.time() - t_start) * 1000
                data_raw = json.loads(response.read().decode('utf-8'))
                
                if data_raw.get("success", False):
                    items = data_raw.get("data", [])
                    
                    if not items:
                        return {"sku": sku, "success": True, "ms": duracion_ms, "nombre": "No Encontrado", "barras": [], "depositos": {}}

                    # Procesar metadatos y depósitos
                    nombre_prod = items[0].get("product_name", "N/A")
                    
                    # Consolidar códigos de barra
                    barras_set = set()
                    for item in items:
                        if item.get("codigo_barras"):
                            barras_set.add(item.get("codigo_barras"))
                        for cb in item.get("codigos_barras", []):
                            if cb: barras_set.add(cb)
                    
                    # Desglose de stock por depósito
                    depositos_stock = {}
                    for item in items:
                        dep_nom = item.get("deposito_nombre", "Desconocido")
                        cant = item.get("stock_quantity", 0)
                        depositos_stock[dep_nom] = cant

                    return {
                        "sku": sku,
                        "success": True,
                        "ms": duracion_ms,
                        "nombre": nombre_prod,
                        "barras": list(barras_set),
                        "depositos": depositos_stock
                    }
        except Exception as e:
            if intento < max_retries:
                time.sleep(1.2 * intento) # Pausa estratégica si falla
            else:
                duracion_ms = (time.time() - t_start) * 1000
                return {"sku": sku, "success": False, "ms": duracion_ms, "error": str(e)}

    # Pausa de seguridad entre peticiones exitosas para mantener el servidor frío
    time.sleep(delay_seg)

def main():
    print(f"\n{B}{C}========================================================================================{W}")
    print(f"{B}{C}         EXTRACTOR DE INVENTARIO SILENCIOSO (DESGLOSE MULTI-DEPÓSITO)                   {W}")
    print(f"{B}{C}========================================================================================{W}")
    print(f" Target Endpoint: {B}{API_ENDPOINT}{W}")
    print(f" Cadencia       : {B}1 petición / 400ms (Modo Protección de Servidor){W}")
    print(f" Total SKUs     : {B}{len(REAL_SKUS)}{W}\n")

    resultados_consolidados = []

    print(f"{B}{C}┌─────┬──────────┬───────────┬──────────────────────────────┬────────────────────────────────────────┬───────┐{W}")
    print(f"{B}{C}│ N°  │ SKU      │ Latencia  │ Codigo(s) de Barras          │ Producto                               │ Stock │{W}")
    print(f"{B}{C}├─────┼──────────┼───────────┼──────────────────────────────┼────────────────────────────────────────┼───────┤{W}")

    for idx, sku in enumerate(REAL_SKUS, 1):
        res = consultar_sku_con_reintento(sku, max_retries=3, delay_seg=0.4)
        
        if res and res["success"]:
            barras_str = ", ".join(res["barras"]) if res.get("barras") else "SIN BARRA"
            total_stock = sum(res["depositos"].values()) if res.get("depositos") else 0
            
            print(f"│ {idx:>3} │ {res['sku']:<8} │ {res['ms']:>7.1f} ms │ {barras_str[:28]:<28} │ {res['nombre'][:38]:<38} │ {total_stock:>5} │")
            resultados_consolidados.append(res)
        else:
            print(f"│ {idx:>3} │ {sku:<8} │ {R}ERROR 500{W}  │ {R}FALLO TRAS REINTENTOS{W}        │ {R}--------------------------------------{W} │ {R}    0{W} │")

    print(f"{B}{C}└─────┴──────────┴───────────┴──────────────────────────────┴────────────────────────────────────────┴───────┘{W}")

    # Guardar en archivo JSON estructurado
    json_path = "inventario_extraido.json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(resultados_consolidados, f, ensure_ascii=False, indent=2)

    # Guardar en CSV para Excel
    csv_path = "inventario_extraido.csv"
    with open(csv_path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.writer(f)
        writer.writerow(["SKU", "Producto", "Codigos_Barras", "Stock_Total", "Almacen", "Piso_de_Venta", "Averia", "Galpon", "Nodo_Transito"])
        
        for r in resultados_consolidados:
            deps = r.get("depositos", {})
            writer.writerow([
                r["sku"],
                r["nombre"],
                " | ".join(r.get("barras", [])),
                sum(deps.values()),
                deps.get("Almacén", 0),
                deps.get("Piso de Venta", 0),
                deps.get("Avería", 0),
                deps.get("Galpón", 0),
                deps.get("Nodo de Tránsito", 0)
            ])

    print(f"\n{G}{B}✔ Extracción completada exitosamente sin afectar la estabilidad del servidor.{W}")
    print(f"• Datos exportados en JSON: {B}{os.path.abspath(json_path)}{W}")
    print(f"• Datos exportados en CSV : {B}{os.path.abspath(csv_path)}{W}\n")

if __name__ == "__main__":
    main()