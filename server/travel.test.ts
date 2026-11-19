import { describe, expect, it } from "vitest";
import { openDb } from "./db.ts";
import { createApp } from "./app.ts";

const J = { "content-type": "application/json" };
const make = () => createApp(openDb(":memory:"), () => new Date(2026, 10, 18, 15, 0, 0));
const send = (app: ReturnType<typeof make>, method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: J, body: body === undefined ? undefined : JSON.stringify(body) });

describe("travel", () => {
  it("tracks a trip from unbooked to booked, with costs and a calendar file", async () => {
    const app = make();
    expect((await send(app, "POST", "/api/trips", { name: " " })).status).toBe(400);
    const trip = await (await send(app, "POST", "/api/trips", { name: "Costa Rica", place: "Liberia", start: "2027-01-04", end: "2027-01-11", budget: 4000 })).json();

    const flight = await (await send(app, "POST", `/api/trips/${trip.id}/items`, { kind: "flight", title: "YYC to LIR", day: "2027-01-04", time: "07:15", cost: 900 })).json();
    await send(app, "POST", `/api/trips/${trip.id}/items`, { kind: "stay", title: "Hotel", day: "2027-01-04", end_day: "2027-01-11", cost: 1400, location: "Playa Hermosa" });
    await send(app, "POST", `/api/trips/${trip.id}/items`, { kind: "event", title: "Dinner, with; friends", day: "2027-01-05", time: "19:00", end_time: "21:00", location: "Tamarindo", url: "https://example.com/x" });
    await send(app, "POST", `/api/trips/${trip.id}/items`, { kind: "cost", title: "Taxi", cost: 60 });
    expect((await send(app, "POST", `/api/trips/${trip.id}/items`, { kind: "event", title: "x", time: "7pm" })).status).toBe(400);
    expect((await send(app, "POST", `/api/trips/${trip.id}/items`, { kind: "nope", title: "x" })).status).toBe(400);

    let view = await (await app.request(`/api/trips/${trip.id}`)).json();
    expect(view).toMatchObject({ to_book: 2, spent: 60, planned: 2360 });

    // Unbooked flight and stay show up on the deck as things to do.
    let deck = await (await app.request("/api/deck")).json();
    const travel = () => deck.areas.find((a: any) => a.id === "travel");
    expect(travel().items.map((t: any) => t.title)).toEqual(["Book YYC to LIR (Costa Rica)", "Book Hotel (Costa Rica)"]);

    await send(app, "PATCH", `/api/trip-items/${flight.id}`, { booked: true });
    view = await (await app.request(`/api/trips/${trip.id}`)).json();
    expect(view).toMatchObject({ to_book: 1, spent: 960 });
    deck = await (await app.request("/api/deck")).json();
    expect(travel().items.map((t: any) => t.title)).toEqual(["Book Hotel (Costa Rica)"]);

    const ics = await (await app.request(`/api/trips/${trip.id}/calendar.ics`)).text();
    expect(ics).toContain("DTSTART:20270104T071500");
    expect(ics).toContain("DTSTART;VALUE=DATE:20270104\r\nDTEND;VALUE=DATE:20270112");
    expect(ics).toContain("SUMMARY:Dinner\\, with\\; friends");
    expect(ics).toContain("DTEND:20270105T210000");
    expect(ics).not.toContain("Taxi");

    expect((await (await app.request("/api/trips")).json()).trips[0]).toMatchObject({ name: "Costa Rica", to_book: 1 });
  });

  it("stores a document and serves it back, and cleans up on delete", async () => {
    const app = make();
    const trip = await (await send(app, "POST", "/api/trips", { name: "T" })).json();
    const form = new FormData();
    form.set("file", new File(["boarding pass"], "pass.txt", { type: "text/plain" }));
    form.set("title", "Boarding pass");
    const doc = await (await app.request(`/api/trips/${trip.id}/items`, { method: "POST", body: form })).json();
    expect(doc).toMatchObject({ kind: "doc", title: "Boarding pass" });
    const got = await app.request(`/api/files/${doc.file_id}`);
    expect(await got.text()).toBe("boarding pass");
    expect(got.headers.get("content-disposition")).toContain("inline");
    await send(app, "DELETE", `/api/trip-items/${doc.id}`);
    expect((await app.request(`/api/files/${doc.file_id}`)).status).toBe(404);
    await send(app, "DELETE", `/api/trips/${trip.id}`);
    expect((await app.request(`/api/trips/${trip.id}`)).status).toBe(404);
  });
});
