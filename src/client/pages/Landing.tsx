import { Link, Navigate } from "react-router-dom";
import { useAuth } from "../lib/auth";

const PORTALS = [
  {
    role: "Patients",
    blurb:
      "Search doctors by specialisation, hold a slot while you describe your symptoms, and get a plain-language summary plus medication reminders after the visit.",
    points: ["Book and cancel appointments", "Symptom form before confirming", "Post-visit summary and prescription"],
  },
  {
    role: "Doctors",
    blurb:
      "Walk into every appointment already briefed: an AI pre-visit summary grades urgency and suggests what to ask before the patient sits down.",
    points: ["Urgency-graded pre-visit summaries", "Suggested questions to ask", "Record notes and prescriptions"],
  },
  {
    role: "Admin",
    blurb:
      "Manage the clinic roster — specialisations, working hours, slot durations — and mark leave days without stranding patients who already booked.",
    points: ["Create and edit doctor profiles", "Set weekly working hours", "Leave days cancel and notify"],
  },
];

const STEPS = [
  { n: "1", t: "Book", d: "Patient picks a doctor and slot. The slot is held for five minutes." },
  { n: "2", t: "Describe", d: "They fill in symptoms; an LLM drafts a pre-visit summary with an urgency level." },
  { n: "3", t: "Visit", d: "The doctor sees that briefing, then records notes and a prescription." },
  { n: "4", t: "Follow up", d: "A patient-friendly summary goes out, and medication reminders are scheduled." },
];

export function Landing() {
  const { user, loading } = useAuth();

  if (loading) return <div className="page-center">Loading...</div>;
  // Someone already signed in wants their dashboard, not the pitch.
  if (user) return <Navigate to={`/${user.role}`} replace />;

  return (
    <div className="landing">
      <header className="landing-nav">
        <span className="brand">Healthcare Appointment &amp; Follow-up Manager</span>
        <nav className="landing-nav-links">
          <Link to="/login">Log in</Link>
          <Link className="button-link" to="/register">
            Register
          </Link>
        </nav>
      </header>

      <section className="hero">
        <h1>
          A clinic booking system that <em>briefs the doctor</em> before you arrive.
        </h1>
        <p>
          Patients share symptoms while booking. Doctors get an AI summary with an urgency level.
          Both sides stay in sync over email and Google Calendar — including when plans change.
        </p>
        <div className="hero-actions">
          <Link className="button-link primary" to="/register">
            Register as a patient
          </Link>
          <Link className="button-link" to="/login">
            Log in
          </Link>
        </div>
        <p className="hero-note">
          Doctor and admin accounts are provisioned by an administrator, so public sign-up creates a
          patient account.
        </p>
      </section>

      <section className="landing-section">
        <h2>Three portals, one system</h2>
        <div className="portal-grid">
          {PORTALS.map((p) => (
            <article key={p.role} className="portal-card">
              <h3>{p.role}</h3>
              <p>{p.blurb}</p>
              <ul>
                {p.points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section className="landing-section">
        <h2>How a visit flows</h2>
        <ol className="step-list">
          {STEPS.map((s) => (
            <li key={s.n}>
              <span className="step-num">{s.n}</span>
              <div>
                <strong>{s.t}</strong>
                <p>{s.d}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="landing-section">
        <h2>Built to handle the awkward cases</h2>
        <div className="detail-grid">
          <div>
            <h4>No double-booking</h4>
            <p>
              A database-level constraint makes two people booking the same slot atomically
              impossible, and requested slots are validated against the doctor's real schedule.
            </p>
          </div>
          <div>
            <h4>Leave days don't strand patients</h4>
            <p>
              Marking a doctor away cancels the affected bookings and notifies both sides instead of
              leaving appointments nobody attends.
            </p>
          </div>
          <div>
            <h4>Notifications retry</h4>
            <p>
              Email goes through an outbox with retries and backoff, so a provider outage delays
              messages rather than losing them.
            </p>
          </div>
          <div>
            <h4>AI failures degrade quietly</h4>
            <p>
              If the LLM is unavailable, the booking and the visit still complete — only the summary
              is marked unavailable.
            </p>
          </div>
        </div>
      </section>

      <footer className="landing-footer">
        <p>Healthcare Appointment &amp; Follow-up Manager</p>
      </footer>
    </div>
  );
}
