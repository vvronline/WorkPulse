import { useCallback, useState } from "react";
import ConfirmDialog from "../components/ConfirmDialog";

type DialogConfig = {
  title?: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  isDanger?: boolean;
  onConfirm?: () => void;
  onCancel?: () => void;
};

type DialogState = DialogConfig & {
  visible: boolean;
  alertMode: boolean;
};

const INITIAL: DialogState = { visible: false, alertMode: false };

/**
 * Small hook that drives a single themed `ConfirmDialog` instance. Use it to
 * replace OS-native `Alert.alert` so dialogs match the app's dark theme.
 *
 *   const { alert, confirm, dialog } = useDialog();
 *   ...
 *   alert("Error", "Something went wrong");
 *   confirm({ title: "Remove?", message: "...", isDanger: true, onConfirm });
 *   ...
 *   {dialog}
 */
export function useDialog() {
  const [state, setState] = useState<DialogState>(INITIAL);

  const close = useCallback(() => setState((s) => ({ ...s, visible: false })), []);

  // Informational / error message — single OK button.
  const alert = useCallback(
    (title: string, message?: string, confirmText = "OK", onConfirm?: () => void) => {
      setState({
        visible: true,
        alertMode: true,
        title,
        message,
        confirmText,
        isDanger: false,
        onConfirm,
        onCancel: undefined,
      });
    },
    [],
  );

  // Yes/no confirmation — runs onConfirm when the confirm button is pressed.
  const confirm = useCallback((config: DialogConfig) => {
    setState({
      visible: true,
      alertMode: false,
      isDanger: true,
      confirmText: "Confirm",
      cancelText: "Cancel",
      ...config,
    });
  }, []);

  const dialog = (
    <ConfirmDialog
      visible={state.visible}
      title={state.title}
      message={state.message}
      confirmText={state.confirmText}
      cancelText={state.cancelText}
      isDanger={state.isDanger}
      alertMode={state.alertMode}
      onCancel={() => {
        const fn = state.onCancel;
        close();
        fn?.();
      }}
      onConfirm={() => {
        const fn = state.onConfirm;
        close();
        fn?.();
      }}
    />
  );

  return { alert, confirm, close, dialog };
}