import { useEffect } from "react";
import { Alert } from "react-native";
import { useDialog } from "../hooks/useDialog";

type AlertButton = {
  text?: string;
  onPress?: () => void;
  style?: "default" | "cancel" | "destructive";
};

type AlertRequest = {
  title: string;
  message?: string;
  buttons?: AlertButton[];
};

type AlertHandler = (request: AlertRequest) => void;

let activeHandler: AlertHandler | null = null;
let bridgeInstalled = false;
let nativeAlertImpl: typeof Alert.alert | null = null;

function registerHandler(handler: AlertHandler) {
  activeHandler = handler;
  return () => {
    if (activeHandler === handler) activeHandler = null;
  };
}

export function installThemedAlertBridge() {
  if (bridgeInstalled) return;
  nativeAlertImpl = Alert.alert.bind(Alert);
  (Alert as any).alert = (
    title: string,
    message?: string,
    buttons?: AlertButton[],
  ) => {
    if (activeHandler) {
      activeHandler({ title, message, buttons });
      return;
    }
    nativeAlertImpl?.(title, message, buttons as any);
  };
  bridgeInstalled = true;
}

export function ThemedAlertHost() {
  const { alert, confirm, dialog } = useDialog();

  useEffect(() => {
    return registerHandler(({ title, message, buttons }) => {
      const options = Array.isArray(buttons) ? buttons.filter(Boolean) : [];
      if (!options.length) {
        alert(title, message);
        return;
      }

      if (options.length === 1) {
        const only = options[0];
        alert(title, message, only.text || "OK", only.onPress);
        return;
      }

      const cancelBtn = options.find((b) => b.style === "cancel");
      const actionBtn = [...options].reverse().find((b) => b.style !== "cancel");

      if (!actionBtn) {
        alert(title, message, cancelBtn?.text || "OK", cancelBtn?.onPress);
        return;
      }

      confirm({
        title,
        message,
        confirmText: actionBtn.text || "OK",
        cancelText: cancelBtn?.text || "Cancel",
        isDanger: actionBtn.style === "destructive",
        onConfirm: actionBtn.onPress,
        onCancel: cancelBtn?.onPress,
      });
    });
  }, [alert, confirm]);

  return dialog;
}
