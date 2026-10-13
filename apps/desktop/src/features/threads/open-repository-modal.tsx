import { useEffect, useRef, useState } from "react";
import { trapDialogFocus } from "../../ui/dialog-focus";

export function OpenRepositoryModal({
  onClose,
  onOpen,
}: {
  readonly onClose: () => void;
  readonly onOpen: (url: string) => Promise<void>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    ref.current?.querySelector("input")?.focus();
  }, []);
  return (
    <div
      className="tree-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <div
        className="tree-modal tree-modal--compact"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Open repository"
        onKeyDown={(event) => {
          if (event.key === "Tab") trapDialogFocus(event, ref.current);
          if (event.key === "Escape" && !pending) onClose();
        }}
      >
        <div className="tree-modal__header">
          <h2 className="tree-modal__title">Open repository</h2>
          <button
            type="button"
            className="tree-modal__close"
            aria-label="Close repository dialog"
            disabled={pending}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <form
          className="tree-modal__summary-step"
          onSubmit={(event) => {
            event.preventDefault();
            if (pending || !url.trim()) return;
            setPending(true);
            setError("");
            onOpen(url).catch((reason: unknown) => {
              setError(String(reason));
              setPending(false);
            });
          }}
        >
          <p className="tree-modal__summary-copy">
            Each thread gets its own remote checkout. Files, commands, Review and the terminal stay
            in its sandbox.
          </p>
          <label className="settings-row__label" htmlFor="repository-url">
            Repository URL
          </label>
          <input
            id="repository-url"
            className="settings-input"
            type="url"
            required
            placeholder="https://github.com/owner/repository"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            disabled={pending}
          />
          <p className="tree-modal__hint">Public HTTPS repositories are supported in this POC.</p>
          {error ? (
            <div role="alert" className="error-banner">
              {error}
            </div>
          ) : null}
          <div className="tree-modal__footer">
            <div className="tree-modal__actions">
              <button
                className="button button--secondary"
                type="button"
                disabled={pending}
                onClick={onClose}
              >
                Cancel
              </button>
              <button
                className="button button--primary"
                type="submit"
                disabled={pending || !url.trim()}
              >
                {pending ? "Opening…" : "Open repository"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

export function OpenRepositoryDialog() {
  const [open, setOpen] = useState(false);
  const api = window.piApp;
  useEffect(() => api?.onOpenRepositoryRequested?.(() => setOpen(true)), [api]);
  return open ? (
    <OpenRepositoryModal
      onClose={() => setOpen(false)}
      onOpen={async (url) => {
        if (!api) throw new Error("The app is unavailable.");
        const added = await api.addWorkspacePath(url);
        if (added.lastError) throw new Error(added.lastError);
        await api.setActiveView("new-thread");
        setOpen(false);
      }}
    />
  ) : null;
}
