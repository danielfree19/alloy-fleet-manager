import { useState } from "react";
import { ApiError } from "@/api/client";
import { changeOwnPassword } from "@/api/identity";
import { PageHeader } from "@/components/PageHeader";
import { useAuthStore } from "@/store/auth";
import { toast } from "@/store/toasts";

/**
 * "My account" — self-service password change.
 *
 * Only valid for actors of kind "user". The env-token and api_token
 * paths show a friendly explainer instead of the form because there's
 * no password to change.
 */
export function SettingsAccount() {
  const actor = useAuthStore((s) => s.actor);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!actor) return null;

  if (actor.kind !== "user") {
    return (
      <>
        <PageHeader title="My account" />
        <div className="card p-6 text-sm">
          <div className="font-medium">
            {actor.kind === "env_token"
              ? "You're signed in via the ADMIN_TOKEN environment variable."
              : "You're signed in via an API token."}
          </div>
          <p className="text-muted mt-2">
            {actor.kind === "env_token"
              ? "There's no user record to manage. Sign in with an email and password to access account settings."
              : "API tokens belong to a user. Sign in to that user's account to change their password."}
          </p>
        </div>
      </>
    );
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (next !== confirm) {
      setError("New password and confirmation don't match.");
      return;
    }
    if (next.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setBusy(true);
    try {
      await changeOwnPassword(current, next);
      toast.success("Password changed.");
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "Current password is incorrect."
          : err instanceof ApiError
            ? err.message
            : "Something went wrong.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="My account"
        subtitle={actor.email ? `Signed in as ${actor.email}` : "Signed in"}
      />
      <form onSubmit={onSubmit} className="card p-6 space-y-4 max-w-md">
        <div className="space-y-1">
          <label className="text-xs text-muted block" htmlFor="current">
            Current password
          </label>
          <input
            id="current"
            type="password"
            className="input"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted block" htmlFor="next">
            New password
          </label>
          <input
            id="next"
            type="password"
            className="input"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            required
            minLength={8}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted block" htmlFor="confirm">
            Confirm new password
          </label>
          <input
            id="confirm"
            type="password"
            className="input"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            minLength={8}
          />
        </div>
        {error && <div className="text-xs text-danger">{error}</div>}
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "Saving…" : "Change password"}
        </button>
      </form>
    </>
  );
}
