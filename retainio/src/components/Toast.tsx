import React, { createContext, useCallback, useContext, useState } from 'react';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';

type ToastVariant = 'success' | 'error' | 'info';

interface ToastItem {
  id: string;
  message: string;
  variant: ToastVariant;
}

interface ToastContextValue {
  showToast: (message: string, variant?: ToastVariant) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const variantStyles: Record<ToastVariant, { container: string; icon: React.ReactNode }> = {
  success: {
    container: 'bg-emerald-500 border-emerald-400',
    icon: <CheckCircle2 className="w-5 h-5 text-white shrink-0" />
  },
  error: {
    container: 'bg-red-600 border-red-500',
    icon: <AlertCircle className="w-5 h-5 text-white shrink-0" />
  },
  info: {
    container: 'bg-slate-900 border-slate-700',
    icon: <Info className="w-5 h-5 text-white shrink-0" />
  }
};

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const showToast = useCallback((message: string, variant: ToastVariant = 'info') => {
    const id = 'toast-' + Date.now().toString() + '-' + Math.random().toString(36).slice(2, 7);
    setToasts(prev => [...prev, { id, message, variant }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4500);
  }, []);

  const dismissToast = (id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}

      <div className="fixed bottom-4 right-4 z-[100] space-y-2 w-full max-w-sm">
        {toasts.map(toast => {
          const style = variantStyles[toast.variant];
          return (
            <div
              key={toast.id}
              role="status"
              className={`p-4 rounded-xl text-white font-bold text-xs shadow-lg flex items-center justify-between space-x-3 border animate-slideDown ${style.container}`}
            >
              <div className="flex items-center space-x-2">
                {style.icon}
                <span>{toast.message}</span>
              </div>
              <button
                onClick={() => dismissToast(toast.id)}
                aria-label="Dismiss notification"
                className="text-white/80 hover:text-white cursor-pointer shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
};

export const useToast = (): ToastContextValue => {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return ctx;
};
