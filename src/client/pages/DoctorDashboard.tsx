import { useEffect, useState } from "react";
import { useAuth } from "../lib/auth";
import { api } from "../lib/api";

type Appointment = {
  id: string;
  patientId: string;
  slotStart: string;
  status: "held" | "confirmed" | "cancelled" | "completed";
  symptomsText: string | null;
  aiPreVisitSummary: {
    urgency: string;
    chiefComplaint: string;
    suggestedQuestions: string[];
  } | null;
  postVisitNotes: string | null;
  aiStatus: string | null;
};

type PrescriptionRow = { medication: string; dosage: string; timesPerDay: number; durationDays: number };

function VisitForm({ appointment, onDone }: { appointment: Appointment; onDone: () => void }) {
  const [notes, setNotes] = useState("");
  const [rows, setRows] = useState<PrescriptionRow[]>([
    { medication: "", dosage: "", timesPerDay: 1, durationDays: 5 },
  ]);
  const [submitting, setSubmitting] = useState(false);

  function updateRow(i: number, patch: Partial<PrescriptionRow>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  async function submit() {
    setSubmitting(true);
    try {
      await api(`/doctor/appointments/${appointment.id}/visit`, {
        method: "POST",
        body: {
          notes,
          prescription: rows.filter((r) => r.medication.trim()),
        },
      });
      onDone();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="visit-form">
      <textarea
        rows={4}
        placeholder="Clinical notes from this visit..."
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      <h4>Prescription</h4>
      {rows.map((r, i) => (
        <div className="row" key={i}>
          <input
            placeholder="Medication"
            value={r.medication}
            onChange={(e) => updateRow(i, { medication: e.target.value })}
          />
          <input
            placeholder="Dosage"
            value={r.dosage}
            onChange={(e) => updateRow(i, { dosage: e.target.value })}
          />
          <input
            type="number"
            min={1}
            placeholder="Times/day"
            value={r.timesPerDay}
            onChange={(e) => updateRow(i, { timesPerDay: Number(e.target.value) })}
          />
          <input
            type="number"
            min={1}
            placeholder="Days"
            value={r.durationDays}
            onChange={(e) => updateRow(i, { durationDays: Number(e.target.value) })}
          />
        </div>
      ))}
      <button
        className="secondary"
        onClick={() => setRows((prev) => [...prev, { medication: "", dosage: "", timesPerDay: 1, durationDays: 5 }])}
      >
        + Add medication
      </button>
      <div className="row">
        <button onClick={submit} disabled={submitting || !notes.trim()}>
          {submitting ? "Saving..." : "Complete visit"}
        </button>
      </div>
    </div>
  );
}

export function DoctorDashboard() {
  const { user, logout } = useAuth();
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [openVisitId, setOpenVisitId] = useState<string | null>(null);

  function load() {
    api<Appointment[]>("/doctor/appointments").then(setAppointments).catch(() => {});
  }

  useEffect(load, []);

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <h1>Dr. {user?.name}</h1>
        <button className="secondary" onClick={logout}>
          Log out
        </button>
      </header>

      <section className="card">
        <h2>Appointments</h2>
        {appointments.length === 0 && <p className="muted">No appointments yet.</p>}
        <ul className="appointment-list">
          {appointments
            .filter((a) => a.status !== "held")
            .map((a) => (
              <li key={a.id} className="appointment">
                <div className="row space-between">
                  <div>
                    <strong>{new Date(a.slotStart).toUTCString()}</strong>
                    <span className={`status status-${a.status}`}>{a.status}</span>
                  </div>
                  {a.status === "confirmed" && (
                    <button
                      className="secondary"
                      onClick={() => setOpenVisitId(openVisitId === a.id ? null : a.id)}
                    >
                      {openVisitId === a.id ? "Close" : "Record visit"}
                    </button>
                  )}
                </div>
                {!a.aiPreVisitSummary && a.aiStatus && (
                  <p className="muted">
                    {a.aiStatus === "daily_limit"
                      ? "AI pre-visit summary unavailable — today's automated summary limit was reached. The patient's own description is below."
                      : "AI pre-visit summary unavailable. The patient's own description is below."}
                    {a.symptomsText ? ` Symptoms: ${a.symptomsText}` : ""}
                  </p>
                )}
                {a.aiPreVisitSummary && (
                  <div className="pre-visit">
                    <p>
                      <strong>Urgency: {a.aiPreVisitSummary.urgency}</strong> — {a.aiPreVisitSummary.chiefComplaint}
                    </p>
                    <p className="muted">Symptoms: {a.symptomsText}</p>
                    <ul>
                      {a.aiPreVisitSummary.suggestedQuestions.map((q, i) => (
                        <li key={i}>{q}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {openVisitId === a.id && (
                  <VisitForm
                    appointment={a}
                    onDone={() => {
                      setOpenVisitId(null);
                      load();
                    }}
                  />
                )}
              </li>
            ))}
        </ul>
      </section>
    </div>
  );
}
