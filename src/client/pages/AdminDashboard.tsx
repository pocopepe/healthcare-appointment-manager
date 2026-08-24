import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { api, ApiError } from "../lib/api";

type Doctor = {
  id: string;
  name: string;
  email: string;
  specialisation: string;
  slotDurationMinutes: number;
};

type AvailabilityRow = { dayOfWeek: number; startTime: string; endTime: string };

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function NewDoctorForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [specialisation, setSpecialisation] = useState("");
  const [slotDuration, setSlotDuration] = useState(30);
  const [availability, setAvailability] = useState<AvailabilityRow[]>([
    { dayOfWeek: 1, startTime: "09:00", endTime: "17:00" },
  ]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function updateRow(i: number, patch: Partial<AvailabilityRow>) {
    setAvailability((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  async function submit() {
    setError(null);
    setSubmitting(true);
    try {
      await api("/admin/doctors", {
        method: "POST",
        body: {
          name,
          email,
          password,
          specialisation,
          slotDurationMinutes: slotDuration,
          availability,
        },
      });
      setName("");
      setEmail("");
      setPassword("");
      setSpecialisation("");
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create doctor");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card">
      <h2>Add a doctor</h2>
      <div className="row">
        <input placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder="Specialisation" value={specialisation} onChange={(e) => setSpecialisation(e.target.value)} />
      </div>
      <div className="row">
        <input placeholder="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input
          placeholder="Temporary password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <input
          type="number"
          min={5}
          placeholder="Slot minutes"
          value={slotDuration}
          onChange={(e) => setSlotDuration(Number(e.target.value))}
        />
      </div>

      <h4>Working hours</h4>
      {availability.map((row, i) => (
        <div className="row" key={i}>
          <select value={row.dayOfWeek} onChange={(e) => updateRow(i, { dayOfWeek: Number(e.target.value) })}>
            {DAYS.map((d, idx) => (
              <option key={idx} value={idx}>
                {d}
              </option>
            ))}
          </select>
          <input type="time" value={row.startTime} onChange={(e) => updateRow(i, { startTime: e.target.value })} />
          <input type="time" value={row.endTime} onChange={(e) => updateRow(i, { endTime: e.target.value })} />
        </div>
      ))}
      <button
        className="secondary"
        onClick={() => setAvailability((prev) => [...prev, { dayOfWeek: 1, startTime: "09:00", endTime: "17:00" }])}
      >
        + Add working day
      </button>

      {error && <p className="error">{error}</p>}
      <div className="row">
        <button onClick={submit} disabled={submitting || !name || !email || !password || !specialisation}>
          {submitting ? "Creating..." : "Create doctor"}
        </button>
      </div>
    </div>
  );
}

function LeaveForm({ doctor }: { doctor: Doctor }) {
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setSubmitting(true);
    setResult(null);
    try {
      const res = await api<{ cancelledAppointments: number }>(`/admin/doctors/${doctor.id}/leave`, {
        method: "POST",
        body: { date, reason },
      });
      setResult(
        res.cancelledAppointments > 0
          ? `Leave recorded. ${res.cancelledAppointments} appointment(s) were cancelled and patients notified.`
          : "Leave recorded.",
      );
      setDate("");
      setReason("");
    } catch (err) {
      setResult(err instanceof ApiError ? err.message : "Could not record leave");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="leave-form">
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      <input placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <button className="secondary" onClick={submit} disabled={submitting || !date}>
        Mark on leave
      </button>
      {result && <p className="muted">{result}</p>}
    </div>
  );
}

export function AdminDashboard() {
  const { user, logout } = useAuth();
  const [doctors, setDoctors] = useState<Doctor[]>([]);

  function load() {
    api<Doctor[]>("/admin/doctors").then(setDoctors).catch(() => {});
  }

  useEffect(load, []);

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <h1>Admin — {user?.name}</h1>
        <div className="row" style={{ marginBottom: 0 }}>
          <Link className="button-link" to="/settings">
            Settings
          </Link>
          <button className="secondary" onClick={logout}>
            Log out
          </button>
        </div>
      </header>

      <NewDoctorForm onCreated={load} />

      <section className="card">
        <h2>Doctors</h2>
        {doctors.length === 0 && <p className="muted">No doctors yet.</p>}
        <ul className="doctor-admin-list">
          {doctors.map((d) => (
            <li key={d.id} className="appointment">
              <strong>
                Dr. {d.name} — {d.specialisation}
              </strong>
              <p className="muted">{d.email}</p>
              <LeaveForm doctor={d} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
