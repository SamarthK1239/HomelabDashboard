import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import { PreferencesProvider } from './components/PreferencesProvider';
import './index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root element is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <PreferencesProvider>
      <App />
    </PreferencesProvider>
  </StrictMode>,
);
