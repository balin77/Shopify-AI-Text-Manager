/**
 * ConfirmContext — imperative confirmation dialog for the whole admin app.
 *
 * Usage:
 *   const confirm = useConfirm();
 *   if (await confirm({ title: "Delete?", message: "…", destructive: true })) {
 *     submit({ action: "delete", ... });
 *   }
 *
 * The dialog is rendered once at the provider root; consumers don't manage
 * open/close state. Returns a Promise that resolves to true (primary action),
 * false (secondary / dismiss / Escape).
 */
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { Modal, Text } from "@shopify/polaris";
import { useI18n } from "./I18nContext";

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red destructive styling on the confirm button. */
  destructive?: boolean;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [state, setState] = useState<{ opts: ConfirmOptions; resolve: (v: boolean) => void } | null>(null);

  const confirm = useCallback<ConfirmFn>((opts) => {
    return new Promise<boolean>((resolve) => setState({ opts, resolve }));
  }, []);

  const close = (result: boolean) => {
    if (!state) return;
    state.resolve(result);
    setState(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {state && (
        <Modal
          open
          onClose={() => close(false)}
          title={state.opts.title}
          primaryAction={{
            content: state.opts.confirmLabel ?? t.common?.confirm ?? "Confirm",
            destructive: state.opts.destructive,
            onAction: () => close(true),
          }}
          secondaryActions={[
            {
              content: state.opts.cancelLabel ?? t.common?.cancel ?? "Cancel",
              onAction: () => close(false),
            },
          ]}
        >
          {state.opts.message != null && (
            <Modal.Section>
              {typeof state.opts.message === "string" ? (
                <Text as="p">{state.opts.message}</Text>
              ) : (
                state.opts.message
              )}
            </Modal.Section>
          )}
        </Modal>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within ConfirmProvider");
  return ctx;
}
