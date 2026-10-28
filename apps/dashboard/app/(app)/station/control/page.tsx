'use client';
// Control centre: smart devices, drones and body cams for an agency or station an admin has switched on.
import { ControlCentre } from '@/components/ControlCentre';

export default function Control() {
  return (
    <>
      <header className="page-head">
        <h1>Control centre</h1>
        <p className="muted">Smart street lights, cameras, drones and officer body cams. See a report scene, launch a drone, watch feeds.</p>
      </header>
      <ControlCentre />
    </>
  );
}
