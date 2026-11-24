"use client";

import { useEffect, useRef } from "react";
import L, { type LatLngTuple } from "leaflet";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerIconRetina from "leaflet/dist/images/marker-icon-2x.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
import "leaflet/dist/leaflet.css";

function markerUrl(asset: string | { src: string }) {
  return typeof asset === "string" ? asset : asset.src;
}

const pin = L.icon({
  iconUrl: markerUrl(markerIcon), iconRetinaUrl: markerUrl(markerIconRetina), shadowUrl: markerUrl(markerShadow),
  iconSize: [25, 41], iconAnchor: [12, 41], shadowSize: [41, 41],
});

export default function ShipmentMap({ pickup, delivery, trail, latest }: {
  pickup: LatLngTuple; delivery: LatLngTuple; trail: LatLngTuple[]; latest: LatLngTuple;
}) {
  const container = useRef<HTMLDivElement>(null);
  const route = useRef<L.LayerGroup>(null);
  const [pickupLat, pickupLng] = pickup;
  const [deliveryLat, deliveryLng] = delivery;

  useEffect(() => {
    const map = L.map(container.current!);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    const start: LatLngTuple = [pickupLat, pickupLng];
    const end: LatLngTuple = [deliveryLat, deliveryLng];
    L.marker(start, { icon: pin, title: "Pickup", alt: "Pickup" }).addTo(map).bindTooltip("Pickup");
    L.marker(end, { icon: pin, title: "Delivery", alt: "Delivery" }).addTo(map).bindTooltip("Delivery");
    map.fitBounds([start, end], { padding: [35, 45], maxZoom: 13 });
    route.current = L.layerGroup().addTo(map);
    return () => { map.remove(); route.current = null; };
  }, [pickupLat, pickupLng, deliveryLat, deliveryLng]);

  useEffect(() => {
    const layer = route.current;
    if (!layer) return;
    layer.clearLayers();
    if (trail.length) L.polyline([[pickupLat, pickupLng], ...trail]).addTo(layer);
    L.circleMarker(latest, { radius: 7, color: "#a83800", fillOpacity: 0.8 })
      .addTo(layer).bindTooltip("Latest position");
  }, [pickupLat, pickupLng, deliveryLat, deliveryLng, trail, latest]);

  return <div ref={container} aria-label="Shipment map" role="region" style={{ height: "min(360px, 60vh)", maxWidth: 800 }} />;
}
