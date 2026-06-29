import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from '@/hooks/AuthProvider';
import { AppRouter } from '@/routes/AppRouter';
import { ToastProvider } from '@/components/ui/toast';
import { DevAgentation } from '@/components/DevAgentation';

export function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <BrowserRouter>
          <AppRouter />
        </BrowserRouter>
      </ToastProvider>
      <DevAgentation />
    </AuthProvider>
  );
}
