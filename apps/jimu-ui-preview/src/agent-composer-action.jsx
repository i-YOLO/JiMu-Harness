import { PaperPlaneRight, Stop } from "@phosphor-icons/react";

export function AgentComposerAction({ action, onSend, onStop }) {
  const stoppingAvailable = action.running || action.submitting;
  return (
    <button
      className="composer-send"
      data-cancel={action.pending || undefined}
      data-cancelling={action.cancelling || undefined}
      type="button"
      aria-label={action.label}
      title={action.label}
      onClick={stoppingAvailable ? onStop : onSend}
      disabled={action.disabled}
    >
      {action.pending
        ? <><span className="composer-stop-spinner" aria-hidden="true" /><Stop data-action-icon="stop" size={13} weight="fill" /></>
        : <PaperPlaneRight data-action-icon="send" size={16} weight="fill" />}
    </button>
  );
}
