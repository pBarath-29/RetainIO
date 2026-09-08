import { useEffect, useRef } from 'react';

interface UseModalA11yOptions {
  closeOnBackdropClick?: boolean;
}

interface UseModalA11yResult {
  dialogRef: React.RefObject<HTMLDivElement | null>;
  backdropProps: {
    onMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void;
  };
}

export function useModalA11y(
  isOpen: boolean,
  onClose: () => void,
  options?: UseModalA11yOptions
): UseModalA11yResult {
  const closeOnBackdropClick = options?.closeOnBackdropClick ?? true;
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // Held in a ref so the setup effect below can depend on `isOpen` ALONE.
  //
  // Callers pass an inline arrow (`onClose={() => setModal(null)}`), which is a new
  // function identity on every render. With onClose in the dependency array the whole
  // effect re-ran on every keystroke inside the modal: the cleanup restored focus to
  // whatever was focused before opening, then the effect moved focus to the first
  // focusable element - the close button. Typing a rejection reason was impossible,
  // because focus jumped to X after each character and the next keypress closed the
  // dialog. This affected every modal using the hook.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;

    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;

    // Prefer a text field over the close button: opening a dialog whose purpose is to
    // type something should put the caret where the typing goes.
    const dialog = dialogRef.current;
    const target =
      dialog?.querySelector<HTMLElement>('textarea, input:not([type="hidden"]), select') ||
      dialog?.querySelector<HTMLElement>('button, [href], [tabindex]:not([tabindex="-1"])') ||
      dialog;
    target?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current();
      }
    };
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocusedRef.current?.focus?.();
    };
  }, [isOpen]);

  const backdropProps = {
    onMouseDown: (e: React.MouseEvent<HTMLDivElement>) => {
      if (closeOnBackdropClick && e.target === e.currentTarget) {
        onCloseRef.current();
      }
    }
  };

  return { dialogRef, backdropProps };
}
