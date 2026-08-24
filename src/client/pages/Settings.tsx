import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { api, ApiError } from "../lib/api";

type CalendarStatus = { configured: boolean; connected: boolean };

export function Settings() {
  const { user, loading } = useAuth();
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Set by the OAuth callback when Google redirects back here.
  const outcome = params.get("calendar");

  function load() {
    api<CalendarStatus>("/calendar/status")
      .then(setStatus)
      .catch(() => setStatus(null));
  }

  useEffect(load, []);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ url: string }>("/calendar/oauth/start");
      // Full page navigation: the consent screen is Google's, not ours.
      window.location.href = res.url;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start the Google sign-in flow");
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!confirm("Disconnect Google Calendar? Existing events stay in your calendar but stop updating.")) return;
    setBusy(true);
    setError(null);
    try {
      await api("/calendar/connection", { method: "DELETE" });
      setParams({});
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not disconnect");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="page-center">Loading...</div>;
  if (!user) return <div className="page-center">Please <Link to="/login">log in</Link>.</div>;

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <h1>Settings</h1>
        <Link className="button-link" to={`/${user.role}`}>
          Back to dashboard
        </Link>
      </header>

      {outcome === "connected" && (
        <div className="banner success">
          <strong>Google Calendar connected.</strong> New bookings will appear in your calendar, and
          cancellations will remove them.
        </div>
      )}
      {outcome === "error" && (
        <div className="banner error-banner">
          <strong>Couldn't connect Google Calendar.</strong> The sign-in was cancelled or the
          authorisation expired. You can try again below.
        </div>
      )}

      <section className="card">
        <h2>Google Calendar</h2>

        {status === null && <p className="muted">Checking connection status...</p>}

        {status && !status.configured && (
          <p className="muted">
            Calendar sync isn't configured for this deployment, so appointments won't be added to
            any calendar. Everything else works normally.
          </p>
        )}

        {status?.configured && (
          <>
            <p className="muted">
              {status.connected
                ? "Your Google Calendar is connected. Appointments you book are added automatically, and cancelling one removes it."
                : "Connect your Google Calendar and every appointment you book will be added to it automatically, then updated or removed if plans change."}
            </p>
            <div className="row">
              {status.connected ? (
                <button className="secondary" onClick={disconnect} disabled={busy}>
                  {busy ? "Working..." : "Disconnect"}
                </button>
              ) : (
                <button onClick={connect} disabled={busy}>
                  {busy ? "Redirecting to Google..." : "Connect Google Calendar"}
                </button>
              )}
            </div>
          </>
        )}

        {error && <p className="error">{error}</p>}
      </section>
    </div>
  );
}
