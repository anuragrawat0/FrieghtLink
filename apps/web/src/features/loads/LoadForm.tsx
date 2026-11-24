import { useId, type FormEvent } from "react";
import { cities } from "./cities";

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

type Stop = "pickup" | "delivery";
type City = readonly [city: string, region: string, latitude: number, longitude: number];

function cityLabel([city, region]: City) {
  return `${city}, ${region}`;
}

export function LoadForm({ load, busy, onSave }: { load?: Load; busy: boolean; onSave: (input: LoadInput, publish: boolean) => void }) {
  const cityList = useId();

  function savedCity(stop: Stop): City | undefined {
    return load && [load[`${stop}City`], load[`${stop}Region`], load[`${stop}Lat`], load[`${stop}Lng`]];
  }

  function selectedCity(input: HTMLInputElement, stop: Stop) {
    const saved = savedCity(stop);
    const label = input.value.trim().toLowerCase();
    const city = saved && cityLabel(saved).toLowerCase() === label
      ? saved : cities.find((entry) => cityLabel(entry).toLowerCase() === label);
    input.setCustomValidity(input.value && !city ? "Choose a city from the list." : "");
    return city;
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const pickup = selectedCity(form.elements.namedItem("pickupCity") as HTMLInputElement, "pickup");
    const delivery = selectedCity(form.elements.namedItem("deliveryCity") as HTMLInputElement, "delivery");
    if (!pickup || !delivery) {
      form.reportValidity();
      return;
    }
    const fields = new FormData(form);
    const text = (name: keyof LoadInput) => String(fields.get(name) ?? "");
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    onSave({
      description: text("description"),
      pickupCity: pickup[0], pickupRegion: pickup[1], pickupLat: pickup[2], pickupLng: pickup[3],
      deliveryCity: delivery[0], deliveryRegion: delivery[1], deliveryLat: delivery[2], deliveryLng: delivery[3],
      pickupReadyAt: new Date(text("pickupReadyAt")).toISOString(), deliveryBy: new Date(text("deliveryBy")).toISOString(),
    }, submitter instanceof HTMLButtonElement && submitter.value === "publish");
  }

  return <form onSubmit={submit}>
    <fieldset disabled={busy}>
      <legend>{load ? "Edit draft" : "Create a draft load"}</legend>
      <p><label>Description <textarea name="description" required maxLength={1000} defaultValue={load?.description} /></label></p>
      <datalist id={cityList}>
        {cities.map((city) => <option key={cityLabel(city)} value={cityLabel(city)} />)}
      </datalist>
      {(["pickup", "delivery"] as const).map((stop) => <fieldset key={stop}>
        <legend>{stop === "pickup" ? "Pickup" : "Delivery"}</legend>
        <p><label>{stop === "pickup" ? "Pickup city" : "Delivery city"}{" "}
          <input name={`${stop}City`} list={cityList} required autoComplete="off"
            defaultValue={load ? cityLabel(savedCity(stop)!) : undefined}
            onChange={(event) => { selectedCity(event.currentTarget, stop); }} />
        </label></p>
        <p>{stop === "pickup"
          ? <label>Ready at (local time) <input name="pickupReadyAt" type="datetime-local" step={0.001} required defaultValue={localDateTime(load?.pickupReadyAt)} /></label>
          : <label>Deliver by (local time) <input name="deliveryBy" type="datetime-local" step={0.001} required defaultValue={localDateTime(load?.deliveryBy)} /></label>}</p>
      </fieldset>)}
      <p><button>{load ? "Save changes" : "Create draft"}</button>{" "}
        {!load && <button type="submit" value="publish">Create and publish</button>}
      </p>
    </fieldset>
  </form>;
}
