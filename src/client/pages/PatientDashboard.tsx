import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { api, ApiError } from "../lib/api";

type Doctor = {
  id: string;
  name: string;
  specialisation: string;
  bio: string | null;
  slotDurationMinutes: number;
};

type Slot = { start: string; end: string };

type Appointment = {
  id: string;
  doctorId: string;
  slotStart: string;
  slotEnd: string;
  status: "confirmed" | "cancelled" | "completed";
  symptomsText: string | null;
  aiPreVisitSummary: {
    urgency: string;
    chiefComplaint: string;
    suggestedQuestions: string[];
  } | null;
  aiPostVisitSummary: string | null;
  aiStatus: string | null;
  prescription: Array<{ medication: string; dosage: string; timesPerDay: number; durationDays: number }> | null;
};

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export function PatientDashboard() {
  const { user, logout } = useAuth();

  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [specialisation, setSpecialisation] = useState("");
  const [selectedDoctor, setSelectedDoctor] = useState<Doctor | null>(null);
  const [date, setDate] = useState(todayIso());
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);

  const [heldAppointmentId, setHeldAppointmentId] = useState<string | null>(null);
  const [symptoms, setSymptoms] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [bookingError, setBookingError] = useState<string | null>(null);
  const [lastSummary, setLastSummary] = useState<Appointment["aiPreVisitSummary"]>(null);

  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [reschedulingId, setReschedulingId] = useState<string | null>(null);
  const [rescheduleDate, setRescheduleDate] = useState(todayIso());
  const [rescheduleSlots, setRescheduleSlots] = useState<Slot[]>([]);
  const [rescheduleError, setRescheduleError] = useState<string | null>(null);

  function loadDoctors() {
    api<Doctor[]>(`/patient/doctors${specialisation ? `?specialisation=${encodeURIComponent(specialisation)}` : ""}`)
      .then(setDoctors)
      .catch(() => {});
  }

  function loadAppointments() {
    api<Appointment[]>("/patient/appointments/mine")
      .then(setAppointments)
      .catch(() => {});
  }

  useEffect(loadDoctors, []);
  useEffect(loadAppointments, []);

  useEffect(() => {
    if (!selectedDoctor) return;
    setSlotsLoading(true);
    api<Slot[]>(`/patient/doctors/${selectedDoctor.id}/slots?date=${date}`)
      .then(setSlots)
      .catch(() => setSlots([]))
      .finally(() => setSlotsLoading(false));
  }, [selectedDoctor, date]);

  async function holdSlot(slot: Slot) {
    if (!selectedDoctor) return;
    setBookingError(null);
    try {
      const res = await api<{ id: string }>("/patient/appointments/hold", {
        method: "POST",
        body: { doctorId: selectedDoctor.id, slotStart: slot.start, slotEnd: slot.end },
      });
      setHeldAppointmentId(res.id);
      setLastSummary(null);
    } catch (err) {
      setBookingError(err instanceof ApiError ? err.message : "Could not hold this slot");
      if (selectedDoctor) {
        api<Slot[]>(`/patient/doctors/${selectedDoctor.id}/slots?date=${date}`).then(setSlots);
      }
    }
  }

  async function confirmBooking() {
    if (!heldAppointmentId) return;
    setConfirming(true);
    setBookingError(null);
    try {
      const res = await api<{ aiPreVisitSummary: Appointment["aiPreVisitSummary"] }>(
        `/patient/appointments/${heldAppointmentId}/confirm`,
        { method: "POST", body: { symptoms } },
      );
      setLastSummary(res.aiPreVisitSummary);
      setHeldAppointmentId(null);
      setSymptoms("");
      setSelectedDoctor(null);
      loadAppointments();
    } catch (err) {
      setBookingError(err instanceof ApiError ? err.message : "Could not confirm booking");
    } finally {
      setConfirming(false);
    }
  }

  function openReschedule(appt: Appointment) {
    setReschedulingId(appt.id);
    setRescheduleError(null);
    const d = appt.slotStart.slice(0, 10);
    const start = d > todayIso() ? d : todayIso();
    setRescheduleDate(start);
    loadRescheduleSlots(appt.doctorId, start);
  }

  function loadRescheduleSlots(doctorId: string, date: string) {
    api<Slot[]>(`/patient/doctors/${doctorId}/slots?date=${date}`)
      .then(setRescheduleSlots)
      .catch(() => setRescheduleSlots([]));
  }

  async function doReschedule(appt: Appointment, slot: Slot) {
    setRescheduleError(null);
    try {
      await api(`/patient/appointments/${appt.id}/reschedule`, {
        method: "POST",
        body: { slotStart: slot.start, slotEnd: slot.end },
      });
      setReschedulingId(null);
      loadAppointments();
    } catch (err) {
      setRescheduleError(err instanceof ApiError ? err.message : "Could not reschedule");
      loadRescheduleSlots(appt.doctorId, rescheduleDate);
    }
  }

  async function cancelAppointment(id: string) {
    if (!confirm("Cancel this appointment?")) return;
    await api(`/patient/appointments/${id}/cancel`, { method: "POST" });
    loadAppointments();
  }

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <h1>Hi, {user?.name}</h1>
        <div className="row" style={{ marginBottom: 0 }}>
          <Link className="button-link" to="/settings">
            Settings
          </Link>
          <button className="secondary" onClick={logout}>
            Log out
          </button>
        </div>
      </header>

      {lastSummary && (
        <div className="banner success">
          <strong>Appointment booked.</strong> Pre-visit urgency: {lastSummary.urgency}. {lastSummary.chiefComplaint}
        </div>
      )}

      <section className="card">
        <h2>Book an appointment</h2>
        <div className="row">
          <input
            placeholder="Filter by specialisation (optional)"
            value={specialisation}
            onChange={(e) => setSpecialisation(e.target.value)}
            onBlur={loadDoctors}
          />
          <input type="date" min={todayIso()} value={date} onChange={(e) => setDate(e.target.value)} />
        </div>

        <div className="doctor-list">
          {doctors.map((d) => (
            <button
              key={d.id}
              className={`doctor-chip ${selectedDoctor?.id === d.id ? "active" : ""}`}
              onClick={() => {
                setSelectedDoctor(d);
                setHeldAppointmentId(null);
              }}
            >
              Dr. {d.name} — {d.specialisation}
            </button>
          ))}
          {doctors.length === 0 && <p className="muted">No doctors found.</p>}
        </div>

        {selectedDoctor && !heldAppointmentId && (
          <div className="slot-picker">
            {slotsLoading && <p className="muted">Loading slots...</p>}
            {!slotsLoading && slots.length === 0 && <p className="muted">No slots available for this date.</p>}
            <div className="slot-grid">
              {slots.map((s) => (
                <button key={s.start} className="slot" onClick={() => holdSlot(s)}>
                  {new Date(s.start).toUTCString().slice(17, 22)}
                </button>
              ))}
            </div>
          </div>
        )}

        {heldAppointmentId && (
          <div className="symptom-form">
            <p>Slot held for 5 minutes. Describe your symptoms to confirm:</p>
            <textarea
              rows={4}
              value={symptoms}
              onChange={(e) => setSymptoms(e.target.value)}
              placeholder="e.g. Dry cough for 3 days, mild fever in the evenings..."
            />
            <div className="row">
              <button onClick={confirmBooking} disabled={confirming || !symptoms.trim()}>
                {confirming ? "Confirming..." : "Confirm booking"}
              </button>
              <button
                className="secondary"
                onClick={() => {
                  setHeldAppointmentId(null);
                  setSymptoms("");
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {bookingError && <p className="error">{bookingError}</p>}
      </section>

      <section className="card">
        <h2>My appointments</h2>
        {appointments.length === 0 && <p className="muted">No appointments yet.</p>}
        <ul className="appointment-list">
          {appointments.map((a) => (
            <li key={a.id} className="appointment">
              <div className="row space-between">
                <div>
                  <strong>{new Date(a.slotStart).toUTCString()}</strong>
                  <span className={`status status-${a.status}`}>{a.status}</span>
                </div>
                {a.status === "confirmed" && (
                  <div className="row" style={{ marginBottom: 0 }}>
                    <button
                      className="secondary"
                      onClick={() =>
                        reschedulingId === a.id ? setReschedulingId(null) : openReschedule(a)
                      }
                    >
                      {reschedulingId === a.id ? "Close" : "Reschedule"}
                    </button>
                    <button className="secondary" onClick={() => cancelAppointment(a.id)}>
                      Cancel
                    </button>
                  </div>
                )}
              </div>
              {reschedulingId === a.id && (
                <div className="slot-picker">
                  <div className="row">
                    <input
                      type="date"
                      min={todayIso()}
                      value={rescheduleDate}
                      onChange={(e) => {
                        setRescheduleDate(e.target.value);
                        loadRescheduleSlots(a.doctorId, e.target.value);
                      }}
                    />
                  </div>
                  {rescheduleSlots.length === 0 && (
                    <p className="muted">No slots available on this date.</p>
                  )}
                  <div className="slot-grid">
                    {rescheduleSlots.map((s) => (
                      <button key={s.start} className="slot" onClick={() => doReschedule(a, s)}>
                        {new Date(s.start).toUTCString().slice(17, 22)}
                      </button>
                    ))}
                  </div>
                  {rescheduleError && <p className="error">{rescheduleError}</p>}
                </div>
              )}
              {a.aiPreVisitSummary && (
                <p className="muted">Urgency: {a.aiPreVisitSummary.urgency} — {a.aiPreVisitSummary.chiefComplaint}</p>
              )}
              {!a.aiPreVisitSummary && a.aiStatus === "daily_limit" && (
                <p className="muted">AI summary unavailable — today's summary limit was reached.</p>
              )}
              {a.status === "completed" && a.aiPostVisitSummary && (
                <div className="post-visit">
                  <p>{a.aiPostVisitSummary}</p>
                  {a.prescription?.map((p, i) => (
                    <p key={i} className="muted">
                      {p.medication} — {p.dosage}, {p.timesPerDay}x/day for {p.durationDays} days
                    </p>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
