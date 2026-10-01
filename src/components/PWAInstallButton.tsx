import React, { useState } from 'react';
import { usePWAInstall } from '../hooks/usePWAInstall';
import { Download, Smartphone, X } from 'lucide-react';

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  // Si ya está ejecutándose como PWA instalada, no mostrar
  if (isInstalled) {
    return null;
  }

  // Flujo Chromium / Android / Desktop
  if (isInstallable) {
    return (
      <button
        onClick={install}
        className="flex items-center gap-2 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs sm:text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 active:scale-95 transition min-h-[38px]"
        title="Instalar AUDITORIAPLUS+ en este dispositivo"
      >
        <Download className="w-4 h-4" />
        <span>Instalar PWA</span>
      </button>
    );
  }

  // Flujo iOS Safari
  if (isIOS) {
    return (
      <>
        <button
          onClick={() => setShowIOSGuide(true)}
          className="flex items-center gap-1.5 rounded-lg border border-slate-600 bg-slate-800/80 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 min-h-[38px]"
        >
          <Smartphone className="w-3.5 h-3.5 text-blue-400" />
          <span>Instalar en iOS</span>
        </button>

        {showIOSGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-xs">
            <div className="w-full max-w-sm rounded-xl bg-slate-900 border border-slate-700 p-6 shadow-2xl text-slate-100">
              <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  <Smartphone className="w-5 h-5 text-emerald-400" />
                  Instalar en iPhone / iPad
                </h3>
                <button
                  onClick={() => setShowIOSGuide(false)}
                  className="p-1 text-slate-400 hover:text-white"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <p className="mt-3 text-sm text-slate-300 leading-relaxed">
                Para instalar la PWA de auditoría en tu colector o dispositivo Apple:
              </p>
              <ol className="mt-3 text-sm space-y-2 text-slate-200 bg-slate-800/60 p-3 rounded-lg border border-slate-700">
                <li className="flex gap-2">
                  <span className="font-bold text-emerald-400">1.</span>
                  <span>Toca el botón <strong>Compartir</strong> en la barra de Safari.</span>
                </li>
                <li className="flex gap-2">
                  <span className="font-bold text-emerald-400">2.</span>
                  <span>Desliza hacia abajo y pulsa <strong>"Agregar a pantalla de inicio"</strong>.</span>
                </li>
              </ol>
              <button
                onClick={() => setShowIOSGuide(false)}
                className="mt-4 w-full rounded-lg bg-emerald-600 py-2.5 text-sm font-bold text-white hover:bg-emerald-700 transition"
              >
                Entendido
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};
