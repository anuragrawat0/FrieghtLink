import type { FormEvent } from "react";

export type LoadInput = {
  description: string;
  pickupCity: string; pickupRegion: string; pickupLat: number; pickupLng: number;
  deliveryCity: string; deliveryRegion: string; deliveryLat: number; deliveryLng: number;
  pickupReadyAt: string; deliveryBy: string;
};

export type Load = LoadInput & {
  id: string;
  shipperId: string;
  status: "DRAFT" | "OPEN" | "ASSIGNED" | "COMPLETED" | "CANCELLED";
  isSample: boolean;
  createdAt: string;
  updatedAt: string;
};

function localDateTime(value?: string) {
  if (!value) return undefined;
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, -1);
}

export function LoadForm({ load, busy, onSave }: { load?: Load; busy: boolean; onSave: (input: LoadInput) => void }) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const text = (name: keyof LoadInput) => String(fields.get(name) ?? "");
    onSave({
      description: text("description"),
      pickupCity: text("pickupCity"), pickupRegion: text("pickupRegion"),
      pickupLat: Number(text("pickupLat")), pickupLng: Number(text("pickupLng")),
      deliveryCity: text("deliveryCity"), deliveryRegion: text("deliveryRegion"),
      deliveryLat: Number(text("deliveryLat")), deliveryLng: Number(text("deliveryLng")),
      pickupReadyAt: new Date(text("pickupReadyAt")).toISOString(), deliveryBy: new Date(text("deliveryBy")).toISOString(),
    });
  }

  return <form onSubmit={submit}>
    <fieldset disabled={busy}>
      <legend>{load ? "Edit draft" : "Create a draft load"}</legend>
      <p><label>Description <textarea name="description" required maxLength={1000} defaultValue={load?.description} /></label></p>
      {(["pickup", "delivery"] as const).map((stop) => <fieldset key={stop}>
        <legend>{stop === "pickup" ? "Pickup" : "Delivery"}</legend>
        <p><label>City <input name={`${stop}City`} required maxLength={100} defaultValue={load?.[`${stop}City`]} /></label></p>
        <p><label>State or DC code <input name={`${stop}Region`} required pattern="[A-Za-z]{2}" maxLength={2} defaultValue={load?.[`${stop}Region`]} /></label></p>
        <p><label>Latitude <input name={`${stop}Lat`} type="number" min={-90} max={90} step="any" required defaultValue={load?.[`${stop}Lat`]} /></label></p>
        <p><label>Longitude <input name={`${stop}Lng`} type="number" min={-180} max={180} step="any" required defaultValue={load?.[`${stop}Lng`]} /></label></p>
        <p>{stop === "pickup"
          ? <label>Ready at (local time) <input name="pickupReadyAt" type="datetime-local" step={0.001} required defaultValue={localDateTime(load?.pickupReadyAt)} /></label>
          : <label>Deliver by (local time) <input name="deliveryBy" type="datetime-local" step={0.001} required defaultValue={localDateTime(load?.deliveryBy)} /></label>}</p>
      </fieldset>)}
      <p><button>{load ? "Save changes" : "Create draft"}</button></p>
    </fieldset>
  </form>;
}
