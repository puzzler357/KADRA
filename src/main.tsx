import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { NotifyProvider } from './components/Toasts';
import LicenseGate from './components/LicenseGate';
import './index.css';
import './i18n';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Тосты и подтверждения доступны всему приложению, включая экран входа. */}
    <NotifyProvider>
      {/* Лицензия проверяется оболочкой до входа: без неё при пустой базе
          показывается экран активации, а с данными — баннер с причиной. */}
      <LicenseGate>
        <App />
      </LicenseGate>
    </NotifyProvider>
  </StrictMode>,
);
