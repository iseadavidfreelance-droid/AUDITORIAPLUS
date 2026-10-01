import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { initOfflineSync } from './lib/sync';

// Inicializar el monitor de red y sincronización en segundo plano
initOfflineSync();

createRoot(document.getElementById('root')!).render(<App />);
